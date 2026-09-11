/**
 * Drives Claude's interactive `/login` flow to completion (PRD §5.3, C-API-43).
 * Runs as an EXCLUSIVE queue task, so no other operation interleaves with the
 * secret code, picker keys, or Enters. Every wait races the overall deadline AND
 * a lifecycle abort signal (fired on session close), so a terminating session or
 * a hung callback settles promptly instead of polling out the full timeout. Each
 * screen is DETECTED, not assumed in a fixed sequence, and the flow resolves only
 * once the CLI reports success AND the session is usable again.
 */

import type { ScreenTerminal } from "../../core/models/tui-screen.ts";
import { awaitLoginOutcome, selectMethodIfShown } from "./stages.ts";
import type { ClaudeLoginOptions } from "./types.ts";

export type LoginIo = {
  readonly terminal: ScreenTerminal;
  /** Whether a blocking dialog is on screen; login writes hold while true. */
  readonly blocked: () => boolean;
  /** Submit the `/login` slash command as an exclusive queue-owned write. */
  readonly submit: (command: string) => Promise<void>;
  /** Resolves when the session next reaches a usable `ready` state after login. */
  readonly awaitUsable: () => Promise<void>;
};

/**
 * Run the whole `/login` flow. `signal` is the caller's combined deadline +
 * lifecycle signal (started when `login()` was called, so it already bounds queue
 * wait); every await settles on the FIRST of success, failure, timeout, or close.
 */
export async function driveLogin(
  io: LoginIo,
  options: ClaudeLoginOptions,
  signal: AbortSignal,
): Promise<void> {
  // Baseline the pre-login screen so stale text present BEFORE this attempt (a
  // model/repo "Paste code here", an old success banner) can never drive the flow:
  // sensitive markers must NEWLY appear after `/login` (C-API-43 security).
  const baseline = io.terminal.snapshot().text;
  await io.submit("/login");
  await selectMethodIfShown(io, options, signal);
  // URL reporting + code entry both live in the outcome poll (the URL can arrive
  // after the browser phrase), so a URL that appears later is still reported.
  await awaitLoginOutcome(io, options, baseline, signal);
  // A success banner alone does not prove usability; wait for a fresh ready state
  // scoped to this attempt before releasing the exclusive lease.
  await io.awaitUsable();
}
