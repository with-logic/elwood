/**
 * Rate-bounded, content-free accounting of transcript observation problems:
 * lost committed data (drops) and contained filesystem read errors.
 * Implements PRD §5.4 (C-CLAUDE-15): a malformed record, an over-length record,
 * an unread teardown backlog, or a transient fs error is surfaced as a running
 * count and byte/kind magnitude with a bounded cause — never raw content.
 *
 * Snapshot vs event vs persist: EVERY observation advances an IN-MEMORY running
 * count (so nothing is lost), but the sink is fed only when the caller `flush()`es
 * at a batch boundary (a scan pass, a teardown-drain call, or finish). Decoupling
 * "update running count" from "persist snapshot" keeps a single 256 KiB chunk full
 * of tiny malformed records from triggering one synchronous session.json rewrite
 * per record: the snapshot is rewritten a BOUNDED number of times per slice, not N.
 * The user-visible warning EVENT stays rate-bounded further downstream: the
 * persistence path (`recordSessionWarnings`) emits the `warning` event only on the
 * FIRST observation while still writing the updated count (C-CLAUDE-15, PRD §5.7).
 */

/** Why committed transcript data was lost, bounded to a fixed token (never content). */
export type DropCause = "unparseable" | "oversized" | "unread_backlog";

/** A bounded, content-free notice that committed transcript data was lost. */
export type TranscriptDropNotice = {
  readonly elwoodSessionId: string;
  readonly path: string;
  /**
   * Total LOSS INCIDENTS so far this session (running count, never raw content):
   * each unparseable record, each over-length record, and each unread teardown
   * backlog is exactly ONE incident. A backlog's enclosed record count is unknown,
   * so incidents — not records — is the only uniformly truthful cardinality.
   */
  readonly droppedCount: number;
  /** Total bytes of the dropped lines (diagnostic magnitude, not content). */
  readonly droppedBytes: number;
  /** The cause of the most recent loss folded into this aggregate (never content). */
  readonly cause: DropCause;
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

/** Tracks lost committed data for one watcher and reports the running aggregate. */
export class DropTracker {
  private count: number;
  private droppedBytes: number;
  private readonly elwoodSessionId: string;
  private readonly onDrop: ((notice: TranscriptDropNotice) => void) | undefined;
  // The pending, un-flushed observation: the latest path + cause and whether any
  // record advanced the aggregate since the last flush. Kept in memory so a chunk
  // full of malformed records advances the count without one persist per record;
  // `flush()` at a batch boundary feeds the sink at most once (the BLOCKER fix).
  private pendingPath: string | undefined;
  private pendingCause: DropCause = "unparseable";
  private dirty = false;

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

  /** Account one unparseable committed record (one loss incident); flushed later. */
  record(path: string, line: string): void {
    this.recordBytes(path, Buffer.byteLength(line, "utf8"), 1, "unparseable");
  }

  // Account `incidents` loss incidents contributing `bytes` under `cause` (each
  // unparseable record, each over-length record, and each unread backlog is ONE
  // incident — never a record count, which is unknowable for a backlog). This only
  // advances the IN-MEMORY running count and marks the pending observation dirty;
  // it never touches the sink, so N incidents in one chunk cause 0 persists here —
  // the batched `flush()` (≤once per slice) is the sole persistence trigger. Both
  // `incidents` and `cause` are explicit (no defaults) so every call site names the
  // cardinality and cause it means, never inheriting a silent wrong default.
  recordBytes(path: string, bytes: number, incidents: number, cause: DropCause): void {
    this.count += incidents;
    this.droppedBytes += bytes;
    this.pendingPath = path;
    this.pendingCause = cause;
    this.dirty = true;
  }

  // Feed the latest aggregate to the sink ONCE if anything changed since the last
  // flush. Called at a batch boundary (scan pass / drain call / finish) so the
  // persisted snapshot is rewritten a bounded number of times per slice — never
  // once per malformed record — while the running count stays current (C-CLAUDE-15).
  flush(): void {
    if (!this.dirty || this.pendingPath === undefined) return;
    this.dirty = false;
    this.onDrop?.({
      elwoodSessionId: this.elwoodSessionId,
      path: this.pendingPath,
      droppedCount: this.count,
      droppedBytes: this.droppedBytes,
      cause: this.pendingCause,
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
