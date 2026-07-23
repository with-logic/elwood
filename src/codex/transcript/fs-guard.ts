/**
 * Contained filesystem access for the Codex transcript watcher.
 * Implements PRD §7A/§5.4: a transcript read that hits a rotation/removal/permission
 * race is contained (never crashes the scan timer or hook dispatch) and recorded as
 * a bounded, content-free diagnostic so a persistent fault stays visible rather than
 * either aborting the host or being swallowed. Codex scans synchronously, so only a
 * sync guard is needed (no async stat twin).
 */

import type { CodexReadErrorReporter } from "./drops.ts";

/** Wraps a synchronous transcript read so a thrown fs error is contained and counted. */
export class CodexTranscriptFsGuard {
  private readonly readErrors: CodexReadErrorReporter;

  constructor(readErrors: CodexReadErrorReporter) {
    this.readErrors = readErrors;
  }

  // Contains a sync read failure (never crashes the timer/hook dispatch) and records
  // a bounded diagnostic so a persistent fault stays visible (§5.4).
  read<T>(path: string, read: () => T): T | undefined {
    try {
      return read();
    } catch (error) {
      this.readErrors.record(path, error);
      return undefined;
    }
  }
}
