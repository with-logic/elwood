/**
 * Bounded, release-able collector for the first PTY output of a session.
 *
 * The startup usability check (see index.ts, `assertStartupUsable`) reads the
 * agent's early output once, at ~500ms, to detect a crash or auth banner.
 * The PTY data handler is never detached for the session's lifetime, so a naive
 * `startupOutput += data` accumulates a second unbounded in-memory transcript
 * for the WHOLE session even though only the startup snapshot is ever consumed.
 *
 * This collector appends only while the startup gate is open and caps the buffer
 * so a chatty CLI cannot balloon it. For a launch the e2e home guard checks, it also
 * watches every chunk, past the cap, for the guard's stop marker (PRD §12, C-E2E-24):
 * after a status-97 exit the check waits up to a second more for that marker before
 * it settles. Once `release()` is called, when the check settles, further chunks are
 * dropped and the retained bytes and the watcher are cleared, so no per-session
 * transcript lingers. Implements PRD §9.1 startup usability and §9.4 resource cleanup.
 */

import type { PtyExit } from "../../pty/types.ts";
import { homeGuardChecksLaunch, watchForStopMarker } from "../home-guard/index.ts";
import { assertStartupUsable, type StartupAdapter } from "./index.ts";

// Startup output is tiny (a banner, a prompt); this cap is comfortably larger
// than any real startup screen while still bounding a misbehaving CLI.
const STARTUP_BUFFER_CAP_BYTES = 64 * 1024;

export type StartupBuffer = {
  /** Appends a PTY chunk while the gate is open; a no-op once released. */
  readonly push: (data: string) => void;
  /** Returns the collected startup output (empty once released). */
  readonly read: () => string;
  /** Stops collecting and clears the retained buffer for the rest of the session. */
  readonly release: () => void;
  /**
   * Whether the output until release, past the cap included, carried the e2e home guard's stop
   * marker (PRD §12, C-E2E-24): the guard writes its line after the startup files' own output,
   * however long that was. `undefined` for a launch the guard does not check, whose output is
   * never scanned for it.
   */
  readonly sawStopMarker: (() => boolean) | undefined;
};

/**
 * `watchStopMarker` defaults to whether the e2e home guard checks a launch started now
 * (`homeGuardChecksLaunch`), as it does the session's.
 */
export function createStartupBuffer(
  options: { readonly capBytes?: number; readonly watchStopMarker?: boolean } = {},
): StartupBuffer {
  const cap = options.capBytes ?? STARTUP_BUFFER_CAP_BYTES;
  let buffer = Buffer.alloc(cap);
  let length = 0;
  let open = true;
  const watched = options.watchStopMarker ?? homeGuardChecksLaunch();
  let stop = watched ? watchForStopMarker() : undefined;
  return {
    push(data: string): void {
      stop?.feed(Buffer.from(data));
      if (!open || length >= cap) return;
      const remaining = cap - length;
      // UTF-8 needs at least as many bytes as UTF-16 units. Only measure chunks
      // already bounded by the remaining capacity; never scan a huge receipt.
      open = data.length <= remaining && Buffer.byteLength(data, "utf8") <= remaining;
      // The bounded write stops before an incomplete code point and copies the
      // prefix into owned storage, without retaining the original chunk string.
      length += buffer.write(data.slice(0, remaining), length, remaining, "utf8");
    },
    read(): string {
      return buffer.toString("utf8", 0, length);
    },
    release(): void {
      open = false;
      buffer = Buffer.alloc(0);
      length = 0;
      stop = undefined;
    },
    sawStopMarker: watched ? () => stop?.seen ?? false : undefined,
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
    await assertStartupUsable({
      adapter,
      exit,
      output: () => buffer.read(),
      sawStopMarker: buffer.sawStopMarker,
    });
  } finally {
    buffer.release();
  }
}
