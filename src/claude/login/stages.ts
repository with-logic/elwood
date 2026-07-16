/**
 * Individual stages of the `/login` flow (PRD §5.3, C-API-43): method selection,
 * URL reporting, and the poll-to-outcome that feeds a validated authorization
 * code. Each stage polls the rendered screen and aborts on the driver's combined
 * deadline/lifecycle signal. Untrusted inputs (the scraped URL, the human code)
 * are validated before they are reported or written.
 */

import { elwoodError } from "../../core/errors.ts";
import type { ScreenTerminal } from "../../core/tui-screen.ts";
import { abortError, pollDelay, raceSettle } from "./abort.ts";
import {
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
  terminal: ScreenTerminal,
  options: ClaudeLoginOptions,
  signal: AbortSignal,
): Promise<void> {
  const shown = await pollUntil(
    terminal,
    signal,
    (t) => methodPickerVisible.test(t) || pastPicker(t),
  );
  if (!methodPickerVisible.test(shown)) return;
  const rows = loginMethodRow[options.method ?? "claudeai"];
  for (let i = 0; i < rows; i += 1) await raceSettle(send(terminal, cursorDown), signal);
  await raceSettle(send(terminal, enter), signal);
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
  const fresh = safeAuthUrl(extractAuthUrl(text) ?? "");
  if (fresh && fresh !== safeAuthUrl(extractAuthUrl(baseline) ?? "")) options.onAuthUrl(fresh);
}

/** Poll to a success/failure outcome, feeding a validated code once if NEWLY prompted. */
export async function awaitLoginOutcome(
  terminal: ScreenTerminal,
  options: ClaudeLoginOptions,
  baseline: string,
  signal: AbortSignal,
): Promise<void> {
  // A marker already present on the pre-login screen is stale and must not settle
  // the outcome nor trigger code disclosure; only markers NEW to this attempt act.
  const succeeded = fresh(loginSucceeded, baseline);
  const failed = fresh(loginFailed, baseline);
  const codePrompt = fresh(pasteCodePrompt, baseline);
  let codeSent = false;
  for (;;) {
    const text = terminal.snapshot().text;
    if (succeeded(text)) return;
    if (failed(text)) throw elwoodError("login_failed", "Claude /login reported a failure.");
    if (!codeSent && codePrompt(text)) {
      codeSent = true;
      await submitCode(terminal, options, signal);
    }
    await pollDelay(signal);
  }
}

// A predicate that matches only when the marker is present now AND was absent from
// the pre-login baseline, so stale on-screen text cannot drive the flow.
function fresh(marker: RegExp, baseline: string): (text: string) => boolean {
  const wasPresent = marker.test(baseline);
  return (text) => marker.test(text) && !wasPresent;
}

/** Ask the caller for the code, validate it, and submit it + one library Enter. */
async function submitCode(
  terminal: ScreenTerminal,
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
  await raceSettle(send(terminal, code), signal);
  await raceSettle(send(terminal, enter), signal);
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

function send(terminal: ScreenTerminal, data: string): Promise<void> {
  return Promise.resolve(terminal.sendInput(data));
}
