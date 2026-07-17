/**
 * Individual stages of the `/login` flow (PRD §5.3, C-API-43): method selection,
 * URL reporting, and the poll-to-outcome that feeds a validated authorization
 * code. Each stage polls the rendered screen and aborts on the driver's combined
 * deadline/lifecycle signal. Untrusted inputs (the scraped URL, the human code)
 * are validated before they are reported or written.
 */

import { elwoodError } from "../../core/errors.ts";
import type { ScreenTerminal } from "../../core/tui-screen.ts";
import { abortError, holdWhileBlocked, pollDelay, raceSettle } from "./abort.ts";
import type { LoginIo } from "./driver.ts";
import {
  activeRegion,
  authUrlVisible,
  extractAuthUrl,
  loginFailed,
  loginSucceeded,
  methodPickerVisible,
  pasteCodePrompt,
} from "./screens.ts";
import type { ClaudeLoginMethod, ClaudeLoginOptions } from "./types.ts";
import { isSafeAuthCode, safeAuthUrl } from "./validate.ts";

// Zero-based row each method occupies in the CLI's "Select login method" list — an
// implementation detail of driving the picker, so it lives here (not public types).
const loginMethodRow: Readonly<Record<ClaudeLoginMethod, number>> = {
  claudeai: 0,
  console: 1,
  third_party: 2,
};

const cursorDown = "\u001b[B";
const enter = "\r";

/** True once the flow has clearly moved past the method picker (or ended). */
function pastPicker(text: string): boolean {
  return (
    authUrlVisible.test(text) ||
    pasteCodePrompt.test(text) ||
    loginSucceeded.test(text) ||
    loginFailed.test(text)
  );
}

/** If the "Select login method" list renders, move to the chosen row and Enter. */
export async function selectMethodIfShown(
  io: LoginIo,
  options: ClaudeLoginOptions,
  signal: AbortSignal,
): Promise<void> {
  const shown = await pollUntil(
    io.terminal,
    signal,
    (t) => methodPickerVisible.test(t) || pastPicker(t),
  );
  if (!methodPickerVisible.test(shown)) return;
  const rows = loginMethodRow[options.method ?? "claudeai"];
  for (let i = 0; i < rows; i += 1) await write(io, cursorDown, signal);
  await write(io, enter, signal);
}

/** Scrape and report the authorization URL once it NEWLY appears (validated). */
export async function reportAuthUrl(
  terminal: ScreenTerminal,
  options: ClaudeLoginOptions,
  baseline: string,
  signal: AbortSignal,
): Promise<void> {
  if (!options.onAuthUrl) return;
  // Only wait a bounded slice: a flow with no URL screen must not stall here.
  const text = await pollUntil(terminal, signal, (t) => authUrlVisible.test(t) || pastPicker(t));
  // A URL already on the baseline screen is stale; require a fresh one.
  const url = safeAuthUrl(extractAuthUrl(text) ?? "");
  if (!url || url === safeAuthUrl(extractAuthUrl(baseline) ?? "")) return;
  // The caller's `onAuthUrl` is untrusted: a throw must become a bounded typed
  // error, never escape raw out of the login transaction.
  try {
    options.onAuthUrl(url);
  } catch (error) {
    throw elwoodError("login_failed", "The /login onAuthUrl callback failed.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Poll to a success/failure outcome, feeding a validated code once if NEWLY prompted. */
export async function awaitLoginOutcome(
  io: LoginIo,
  options: ClaudeLoginOptions,
  baseline: string,
  signal: AbortSignal,
): Promise<void> {
  const terminal = io.terminal;
  // Scope each marker to the screen's ACTIVE region and require it NEW to this
  // attempt: unrelated model/repo text scrolled into the viewport — even newly —
  // is outside the active prompt region, so it cannot settle the outcome or
  // trigger code disclosure. The code prompt additionally only acts once the flow
  // has entered the AUTHORIZING stage (a URL/browser prompt was seen), enforcing
  // ordered stages so a bare "Paste code here" can never front-run the flow.
  const succeeded = freshInRegion(loginSucceeded, baseline);
  const failed = freshInRegion(loginFailed, baseline);
  const codePrompt = freshInRegion(pasteCodePrompt, baseline);
  let authorizing = false;
  let codeSent = false;
  for (;;) {
    const text = terminal.snapshot().text;
    authorizing ||= authUrlVisible.test(activeRegion(text));
    if (succeeded(text)) return;
    if (failed(text)) throw elwoodError("login_failed", "Claude /login reported a failure.");
    if (authorizing && !codeSent && codePrompt(text)) {
      codeSent = true;
      await submitCode(io, options, signal);
    }
    await pollDelay(signal);
  }
}

// A predicate matching only when the marker is in the current ACTIVE region AND
// was absent from the pre-login baseline's active region — so neither stale nor
// off-region on-screen text can drive the flow.
function freshInRegion(marker: RegExp, baseline: string): (text: string) => boolean {
  const wasPresent = marker.test(activeRegion(baseline));
  return (text) => marker.test(activeRegion(text)) && !wasPresent;
}

/** Ask the caller for the code, validate it, and submit it + one library Enter. */
async function submitCode(
  io: LoginIo,
  options: ClaudeLoginOptions,
  signal: AbortSignal,
): Promise<void> {
  let code: string;
  try {
    code = await raceSettle(Promise.resolve(options.provideCode()), signal);
  } catch (error) {
    if (signal.aborted) throw abortError(signal);
    throw elwoodError("login_failed", "The /login code callback failed.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (!isSafeAuthCode(code)) {
    throw elwoodError(
      "login_failed",
      "The /login authorization code was empty, oversized, or contained control characters.",
    );
  }
  await write(io, code, signal);
  await write(io, enter, signal);
}

/** Poll `snapshot().text` until `test` holds; aborts on the combined signal. */
async function pollUntil(
  terminal: ScreenTerminal,
  signal: AbortSignal,
  test: (text: string) => boolean,
): Promise<string> {
  for (;;) {
    const text = terminal.snapshot().text;
    if (test(text)) return text;
    await pollDelay(signal);
  }
}

// Write a login keystroke: hold while a blocking dialog is on screen (dialog
// safety — a keystroke there would confirm its option), then write, racing the
// deadline/lifecycle signal throughout.
async function write(io: LoginIo, data: string, signal: AbortSignal): Promise<void> {
  await holdWhileBlocked(io.blocked, signal);
  await raceSettle(Promise.resolve(io.terminal.sendInput(data)), signal);
}
