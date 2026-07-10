/**
 * Contained filesystem access for the transcript watcher.
 * Implements PRD §5.4 (C-CLAUDE-15): a transcript read that hits a
 * rotation/removal/permission race is contained (never crashes the timer or hook
 * dispatch) and recorded as a bounded, content-free diagnostic so a persistent
 * fault stays visible rather than either aborting the host or being swallowed.
 */

import type { ReadErrorTracker } from "./drops.ts";

/**
 * Wraps a synchronous or async transcript read so a thrown/rejected fs error is
 * contained and counted. `isFinished` gates async recording: a stat kicked off
 * before finish() can reject AFTER the watcher is terminal, and recording it then
 * would emit/persist activity past `terminal:exit`, breaking the permanent latch
 * (§5.4) — so a post-finish rejection is swallowed content-free instead.
 */
export class TranscriptFsGuard {
  private readonly readErrors: ReadErrorTracker;
  private readonly isFinished: () => boolean;

  constructor(readErrors: ReadErrorTracker, isFinished: () => boolean) {
    this.readErrors = readErrors;
    this.isFinished = isFinished;
  }

  // Contains a sync read failure (never crashes the timer/hook dispatch) and
  // records a bounded diagnostic so a persistent fault stays visible (§5.4).
  read<T>(path: string, read: () => T): T | undefined {
    try {
      return read();
    } catch (error) {
      this.readErrors.record(path, error);
      return undefined;
    }
  }

  // Async twin of read: contains a rejected stat during polling. Recorded only
  // while `!isFinished()` so a post-finish rejection cannot emit past the latch;
  // poll()'s own post-await check still bails on the terminal case (§5.4).
  async readAsync(path: string, read: () => Promise<boolean>): Promise<boolean> {
    try {
      return await read();
    } catch (error) {
      if (!this.isFinished()) this.readErrors.record(path, error);
      return false;
    }
  }
}
