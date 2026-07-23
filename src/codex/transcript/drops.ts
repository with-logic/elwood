/**
 * Rate-bounded, content-free accounting of Codex transcript observation problems:
 * lost committed data (drops) and contained filesystem read errors.
 * Implements PRD §7A/§5.4: a malformed record, an over-length record, an unread
 * teardown backlog, or a transient fs error is surfaced as a running count and
 * byte/kind magnitude with a bounded cause — never raw content. Mirrors Claude's
 * drop tracker: every observation advances an IN-MEMORY running count, but the
 * sink is fed only when the caller `flush()`es at a batch boundary, so one chunk
 * full of tiny malformed records causes a bounded number of persists, not N.
 */

import type { DropCause } from "../../core/warning-reasons.ts";

export type { DropCause };

/** A bounded, content-free notice that committed Codex transcript data was lost. */
export type CodexDropNotice = {
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

/** A bounded, content-free notice that Codex transcript filesystem reads failed. */
export type CodexReadErrorNotice = {
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
export class CodexDropTracker {
  private count: number;
  private droppedBytes: number;
  private readonly elwoodSessionId: string;
  private readonly onDrop: ((notice: CodexDropNotice) => void) | undefined;
  // The pending, un-flushed observation: the latest path + cause and whether any
  // record advanced the aggregate since the last flush, kept in memory so a chunk
  // full of malformed records advances the count without one persist per record.
  private pendingPath: string | undefined;
  private pendingCause: DropCause = "unparseable";
  private dirty = false;

  // `seed` carries the prior snapshot totals so a resumed watcher continues the
  // running count instead of restarting at 0 — a same-code warning's persisted
  // count must never go backwards.
  constructor(
    elwoodSessionId: string,
    onDrop: ((notice: CodexDropNotice) => void) | undefined,
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

  // Account `incidents` loss incidents contributing `bytes` under `cause`. Advances
  // only the IN-MEMORY running count and marks the pending observation dirty; it
  // never touches the sink, so N incidents in one chunk cause 0 persists here — the
  // batched `flush()` (≤once per slice) is the sole persistence trigger. Both
  // `incidents` and `cause` are explicit so every call site names them.
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
  // once per malformed record — while the running count stays current.
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
export class CodexReadErrorTracker {
  private count: number;
  private readonly elwoodSessionId: string;
  private readonly onError: ((notice: CodexReadErrorNotice) => void) | undefined;

  constructor(
    elwoodSessionId: string,
    onError: ((notice: CodexReadErrorNotice) => void) | undefined,
    seed?: ReadErrorSeed,
  ) {
    this.elwoodSessionId = elwoodSessionId;
    this.onError = onError;
    this.count = seed?.errorCount ?? 0;
  }

  record(path: string, error: unknown): void {
    this.count += 1;
    // `code` is only a string on a real errno; a non-string (e.g. a numeric `code`)
    // must NOT round-trip as `lastErrorCode`, whose public/persisted type is a string.
    const code = (error as { code?: unknown } | null)?.code;
    const lastErrorCode = typeof code === "string" ? code : "UNKNOWN";
    this.onError?.({
      elwoodSessionId: this.elwoodSessionId,
      path,
      errorCount: this.count,
      lastErrorCode,
    });
  }
}
