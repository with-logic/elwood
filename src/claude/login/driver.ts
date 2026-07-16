/**
 * Drives Claude's interactive `/login` flow to completion (PRD §5.3, C-API-43).
 * Defensive by design: auth can take several shapes, so each screen is DETECTED
 * rather than assumed in a fixed sequence. The driver submits `/login`, optionally
 * selects a login method, hands the browser URL to the caller, feeds a pasted
 * authorization code when the CLI asks for one, and resolves on success — or
 * rejects with `login_failed`/`login_timeout`. It never assumes the code prompt
 * appears: a self-completing flow resolves on success without asking for a code.
 */

import { elwoodError } from "../../core/errors.ts";
import type { ScreenTerminal } from "../../core/tui-screen.ts";
import {
  authUrlVisible,
  extractAuthUrl,
  loginFailed,
  loginSucceeded,
  methodPickerVisible,
  pasteCodePrompt,
} from "./screens.ts";
import { type ClaudeLoginOptions, defaultLoginTimeoutMs, loginMethodRow } from "./types.ts";

const loginCommand = "/login";
const pollMs = 100;
const cursorDown = "\u001b[B";
const enter = "\r";

export type LoginIo = {
  readonly terminal: ScreenTerminal;
  /** Submit the `/login` slash command through the serialized command queue. */
  readonly submit: (command: string) => Promise<void>;
};

/** Run the whole `/login` flow; resolves on success, rejects on failure/timeout. */
export async function driveLogin(io: LoginIo, options: ClaudeLoginOptions): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? defaultLoginTimeoutMs);
  await io.submit(loginCommand);
  await selectMethodIfShown(io, options, deadline);
  await runToCompletion(io, options, deadline);
}

/** If the "Select login method" list renders, move to the chosen row and Enter. */
async function selectMethodIfShown(
  io: LoginIo,
  options: ClaudeLoginOptions,
  deadline: number,
): Promise<void> {
  // The picker is optional: wait until it renders OR the flow has clearly moved on
  // (URL/code/success/failure), and skip selection if it never appears — a
  // single-method setup or a flow that failed before the picker.
  const shown = await settleUntil(
    io,
    (t) => methodPickerVisible.test(t) || pastPicker(t),
    deadline,
  );
  if (!methodPickerVisible.test(shown)) return;
  const rows = loginMethodRow[options.method ?? "claudeai"];
  for (let i = 0; i < rows; i += 1) await io.terminal.sendInput(cursorDown);
  await io.terminal.sendInput(enter);
}

/** Poll until success/failure, reporting the URL and feeding a pasted code once each. */
async function runToCompletion(
  io: LoginIo,
  options: ClaudeLoginOptions,
  deadline: number,
): Promise<void> {
  let urlReported = false;
  let codeSent = false;
  while (Date.now() < deadline) {
    const text = io.terminal.snapshot().text;
    if (loginSucceeded.test(text)) return;
    if (loginFailed.test(text))
      throw elwoodError("login_failed", "Claude /login reported a failure.");
    // Report the browser URL the first frame it appears (best-effort, once).
    if (!urlReported && options.onAuthUrl) {
      const url = extractAuthUrl(text);
      if (url) {
        urlReported = true;
        options.onAuthUrl(url);
      }
    }
    if (!codeSent && pasteCodePrompt.test(text)) {
      codeSent = true;
      const code = await options.provideCode();
      await io.terminal.sendInput(code);
      await io.terminal.sendInput(enter);
    }
    await delay(pollMs);
  }
  throw elwoodError("login_timeout", "Claude /login did not report success in time.");
}

/** True once the flow has clearly moved past the method picker (or ended). */
function pastPicker(text: string): boolean {
  return (
    authUrlVisible.test(text) ||
    pasteCodePrompt.test(text) ||
    loginSucceeded.test(text) ||
    loginFailed.test(text)
  );
}

/** Poll `snapshot().text` until `test` holds or the deadline passes; returns last text. */
async function settleUntil(
  io: LoginIo,
  test: (text: string) => boolean,
  deadline: number,
): Promise<string> {
  let text = io.terminal.snapshot().text;
  while (!test(text) && Date.now() < deadline) {
    await delay(pollMs);
    text = io.terminal.snapshot().text;
  }
  return text;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
