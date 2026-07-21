/**
 * Bounded, release-able collector for the first PTY output of a session.
 *
 * The startup usability check (see startup.ts, `assertStartupUsable`) reads the
 * agent's early output exactly once at ~500ms to detect a crash or auth banner.
 * The PTY data handler is never detached for the session's lifetime, so a naive
 * `startupOutput += data` accumulates a second unbounded in-memory transcript
 * for the WHOLE session even though only the startup snapshot is ever consumed.
 *
 * This collector appends only while the startup gate is open and caps the buffer
 * so a chatty CLI cannot balloon it; once `release()` is called (right after the
 * usability check reads it) further chunks are dropped and the retained string is
 * cleared, so no per-session transcript lingers. Implements PRD §9.1 startup
 * usability and §9.4 resource cleanup.
 */

import type { PtyExit } from "../pty/types.ts";
import { assertStartupUsable, type StartupAdapter } from "./startup.ts";

// Startup output is tiny (a banner, a prompt); this cap is comfortably larger
// than any real startup screen while still bounding a misbehaving CLI.
const STARTUP_BUFFER_CAP = 64 * 1024;

export type StartupBuffer = {
  /** Appends a PTY chunk while the gate is open; a no-op once released. */
  readonly push: (data: string) => void;
  /** Returns the collected startup output (empty once released). */
  readonly read: () => string;
  /** Stops collecting and clears the retained buffer for the rest of the session. */
  readonly release: () => void;
};

export function createStartupBuffer(cap: number = STARTUP_BUFFER_CAP): StartupBuffer {
  let buffer = "";
  let open = true;
  return {
    push(data: string): void {
      if (!open || buffer.length >= cap) return;
      buffer += data;
      if (buffer.length > cap) buffer = buffer.slice(0, cap);
    },
    read(): string {
      return buffer;
    },
    release(): void {
      open = false;
      buffer = "";
    },
  };
}

/**
 * Runs the ~500ms startup usability check against `buffer`, then releases it on
 * every path (success OR failure) so the collector stops appending and clears
 * its retained string for the rest of the session (§9.1, §9.4).
 */
export async function assertStartupThenRelease(
  adapter: StartupAdapter,
  buffer: StartupBuffer,
  exit: () => PtyExit | undefined,
): Promise<void> {
  try {
    await assertStartupUsable({ adapter, exit, output: () => buffer.read() });
  } finally {
    buffer.release();
  }
}
