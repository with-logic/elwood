/**
 * Rate-bounded, content-free accounting of transcript observation problems shared by
 * both adapters: lost committed data (drops) and contained filesystem read errors.
 * Implements PRD §5.4 (C-CLAUDE-15 / §7A): a malformed record, an over-length record,
 * an unread teardown backlog, or a transient fs error is surfaced as a running count
 * and byte/kind magnitude with a bounded cause — never raw content.
 *
 * Snapshot vs event vs persist: EVERY observation advances an IN-MEMORY running count
 * (so nothing is lost), but the sink is fed only when the caller `flush()`es at a
 * batch boundary (a scan pass, a teardown-drain call, or finish). Decoupling "update
 * running count" from "persist snapshot" keeps a single 256 KiB chunk full of tiny
 * malformed records from triggering one synchronous session.json rewrite per record:
 * the snapshot is rewritten a BOUNDED number of times per slice, not N. The
 * user-visible warning EVENT stays rate-bounded further downstream: the persistence
 * path emits the `warning` event only on the FIRST observation while still writing
 * the updated count (C-CLAUDE-15, PRD §5.7).
 */

import type { DropCause } from "../warning-reasons.ts";

export type { DropCause };

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

/**
 * A delta folded into the running drop aggregate: continuation `bytes`, an
 * `incidents` count (which may be 0 while bytes are still added — e.g. an oversized
 * line's trailing chunks), plus the latest `path`/`cause`. A NAMED object (not
 * positional args): `bytes` and `incidents` are both `number`, so passing them
 * positionally would let a swap compile and silently corrupt the persisted totals.
 */
export type DropAccountingDelta = {
  readonly path: string;
  /** Bytes of the dropped data folded into this observation (magnitude, not content). */
  readonly bytes: number;
  /** Loss incidents this observation adds (each record/backlog is exactly one). */
  readonly incidents: number;
  readonly cause: DropCause;
};

/** Tracks lost committed data for one watcher and reports the running aggregate. */
export class DropTracker {
  private count: number;
  private droppedBytes: number;
  private readonly elwoodSessionId: string;
  private readonly onDrop: ((notice: TranscriptDropNotice) => void) | undefined;
  // The pending, un-flushed observation: the latest path + cause and whether any
  // record advanced the aggregate since the last flush, kept in memory so a chunk
  // full of malformed records advances the count without one persist per record;
  // `flush()` at a batch boundary feeds the sink at most once.
  private pendingPath: string | undefined;
  private pendingCause: DropCause = "unparseable";
  private dirty = false;

  // `seed` carries the prior snapshot totals so a resumed watcher continues the
  // running count instead of restarting at 0 — a same-code warning's persisted
  // count must never go backwards.
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
    this.accountDrop({
      path,
      bytes: Buffer.byteLength(line, "utf8"),
      incidents: 1,
      cause: "unparseable",
    });
  }

  // Account `incidents` loss incidents contributing `bytes` under `cause`. This only
  // advances the IN-MEMORY running count and marks the pending observation dirty; it
  // never touches the sink, so N incidents in one chunk cause 0 persists here — the
  // batched `flush()` (≤once per slice) is the sole persistence trigger. The args are
  // a NAMED object (not positional): `bytes` and `incidents` are both numbers, so a
  // positional swap would silently corrupt persisted diagnostics.
  accountDrop({ path, bytes, incidents, cause }: DropAccountingDelta): void {
    this.count += incidents;
    this.droppedBytes += bytes;
    this.pendingPath = path;
    this.pendingCause = cause;
    this.dirty = true;
  }

  // Feed the latest aggregate to the sink ONCE if anything changed since the last
  // flush. Called at a batch boundary (scan pass / drain call / finish) so the
  // persisted snapshot is rewritten a bounded number of times per slice — never once
  // per malformed record — while the running count stays current.
  flush(): void {
    if (!this.dirty || this.pendingPath === undefined) return;
    this.onDrop?.({
      elwoodSessionId: this.elwoodSessionId,
      path: this.pendingPath,
      droppedCount: this.count,
      droppedBytes: this.droppedBytes,
      cause: this.pendingCause,
    });
    // Clear `dirty` only AFTER onDrop returns: a throwing sink must not drop the
    // running total — the next flush re-emits it rather than losing it silently.
    this.dirty = false;
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
  // running count instead of restarting at 0.
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
    // `code` is only a string on a real errno; a non-string (e.g. a numeric `code`)
    // must NOT round-trip as `lastErrorCode`, whose public/persisted type is a string
    // — else the record fails validation as `state_corrupt`.
    const code = (error as { code?: unknown } | null)?.code;
    const lastErrorCode = typeof code === "string" ? code : "UNKNOWN";
    // Every contained error updates the persisted count; the warning event that
    // reaches the user is de-duplicated downstream.
    this.onError?.({
      elwoodSessionId: this.elwoodSessionId,
      path,
      errorCount: this.count,
      lastErrorCode,
    });
  }
}
