/**
 * Bounded steps for real-CLI e2e tests: each fails under its own label with the
 * session's status and the screen's tail, instead of the runner's unlabeled timeout.
 * Supports PRD §12 and C-E2E-03.
 */

import { type E2eSession, waitFor } from "./helpers.ts";

/** Explains a timed-out step with the session's status and the screen's tail. */
function stuck(session: E2eSession, reason: string): Error {
  const screen = session.terminal.snapshot().text.trimEnd().split("\n").slice(-12).join("\n");
  return new Error(`${reason} (status ${session.status}); screen:\n${screen}`);
}

/** Waits until `condition` holds, failing with the screen after `timeoutMs`. */
export async function waitForCondition(
  session: E2eSession,
  condition: () => boolean,
  label: string,
  timeoutMs: number,
): Promise<void> {
  try {
    await waitFor(() => (condition() ? true : undefined), label, timeoutMs);
  } catch (error) {
    throw stuck(session, error instanceof Error ? error.message : String(error));
  }
}

/**
 * Sends `text`, failing with the screen if the submission has not resolved within
 * `timeoutMs`. A message queued before readiness stays pending until it dispatches, so
 * a session that never becomes ready would otherwise hold the test until the runner's
 * timeout. The caller's teardown then rejects the abandoned send.
 */
export async function sendWithin(
  session: E2eSession,
  text: string,
  label: string,
  timeoutMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(stuck(session, `Timed out sending ${label}`)), timeoutMs);
  });
  try {
    await Promise.race([session.sendMessage(text), expired]);
  } finally {
    clearTimeout(timer);
  }
}
