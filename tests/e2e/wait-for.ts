/**
 * Polls a reading until it yields a value, for the real-agent e2e tests (PRD §12). Kept
 * apart from `helpers.ts` so the bounded steps built on it load without the e2e harness.
 */

import { e2eTimeoutMs } from "./timeout.ts";

export async function waitFor<T>(
  read: () => T | undefined | Promise<T | undefined>,
  label: string,
  timeoutMs = e2eTimeoutMs,
): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
