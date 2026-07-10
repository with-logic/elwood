/**
 * Rate-bounded, content-free accounting of transcript observation problems:
 * unparseable committed records (drops) and contained filesystem read errors.
 * Implements PRD §5.4 (C-CLAUDE-15): a malformed record or a transient fs error
 * is surfaced as a running count and byte/kind magnitude — never raw content.
 *
 * Snapshot vs event: the tracker feeds EVERY updated aggregate to its sink so the
 * persisted snapshot count stays current even if the host crashes before exit.
 * The user-visible warning EVENT stays rate-bounded downstream: the persistence
 * path (`recordSessionWarnings`) suppresses duplicate events while still writing
 * the updated count, so a repeated observation updates the count without emitting
 * a duplicate `warning` event (C-CLAUDE-15, PRD §5.7).
 */

/** A bounded, content-free notice that committed records could not be parsed. */
export type TranscriptDropNotice = {
  readonly elwoodSessionId: string;
  readonly path: string;
  /** Total dropped so far this session (running count, never the raw content). */
  readonly droppedCount: number;
  /** Total bytes of the dropped lines (diagnostic magnitude, not content). */
  readonly droppedBytes: number;
};

/** A bounded, content-free notice that transcript filesystem reads failed. */
export type TranscriptReadErrorNotice = {
  readonly elwoodSessionId: string;
  readonly path: string;
  /** Total contained fs errors so far this session (running count). */
  readonly errorCount: number;
  /** The most recent error's code (e.g. "ENOENT", "EISDIR"), for diagnosis. */
  readonly lastErrorCode: string;
};

/** Prior running totals recovered from a persisted snapshot when a watcher resumes. */
export type DropSeed = { readonly droppedCount: number; readonly droppedBytes: number };

/** Tracks unparseable records for one watcher and reports the running aggregate. */
export class DropTracker {
  private count: number;
  private droppedBytes: number;
  private readonly elwoodSessionId: string;
  private readonly onDrop: ((notice: TranscriptDropNotice) => void) | undefined;

  // `seed` carries the prior snapshot totals so a resumed watcher continues the
  // running count instead of restarting at 0 — a same-code warning's persisted
  // count must never go backwards (C-CLAUDE-15).
  constructor(
    elwoodSessionId: string,
    onDrop: ((notice: TranscriptDropNotice) => void) | undefined,
    seed?: DropSeed,
  ) {
    this.elwoodSessionId = elwoodSessionId;
    this.onDrop = onDrop;
    this.count = seed?.droppedCount ?? 0;
    this.droppedBytes = seed?.droppedBytes ?? 0;
  }

  record(path: string, line: string): void {
    this.recordBytes(path, Buffer.byteLength(line, "utf8"));
  }

  /** Count `records` dropped lines contributing `bytes` and report the new aggregate. */
  recordBytes(path: string, bytes: number, records = 1): void {
    this.count += records;
    this.droppedBytes += bytes;
    // Feed every updated aggregate to the sink: the snapshot count must stay
    // current even though the persistence path emits at most one warning EVENT.
    this.onDrop?.({
      elwoodSessionId: this.elwoodSessionId,
      path,
      droppedCount: this.count,
      droppedBytes: this.droppedBytes,
    });
  }
}

/** Prior error total recovered from a persisted snapshot when a watcher resumes. */
export type ReadErrorSeed = { readonly errorCount: number };

/** Tracks contained filesystem read errors for one watcher and reports the aggregate. */
export class ReadErrorTracker {
  private count: number;
  private readonly elwoodSessionId: string;
  private readonly onError: ((notice: TranscriptReadErrorNotice) => void) | undefined;

  // `seed` carries the prior snapshot total so a resumed watcher continues the
  // running count instead of restarting at 0 (C-CLAUDE-15).
  constructor(
    elwoodSessionId: string,
    onError: ((notice: TranscriptReadErrorNotice) => void) | undefined,
    seed?: ReadErrorSeed,
  ) {
    this.elwoodSessionId = elwoodSessionId;
    this.onError = onError;
    this.count = seed?.errorCount ?? 0;
  }

  record(path: string, error: unknown): void {
    this.count += 1;
    const lastErrorCode = (error as NodeJS.ErrnoException)?.code ?? "UNKNOWN";
    // Every contained error updates the persisted count; the warning event that
    // reaches the user is de-duplicated downstream (recordSessionWarnings).
    this.onError?.({
      elwoodSessionId: this.elwoodSessionId,
      path,
      errorCount: this.count,
      lastErrorCode,
    });
  }
}
