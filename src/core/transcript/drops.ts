/**
 * Content-free, live-only reporting of transcript observation problems shared by
 * both adapters: lost committed data (drops) and contained filesystem read errors.
 * Implements PRD §5.4 (C-CLAUDE-15 / §7A): a malformed record, an over-length record,
 * an unread teardown backlog, or a transient fs error is surfaced as a live warning
 * carrying only its path and a bounded cause/error-code — never raw content, never a
 * running count. A human at the terminal sees each problem once, live; Elwood mirrors
 * that (no persistence, no aggregate, no cross-resume continuation).
 *
 * Drop DELIVERY is bounded per scan pass: a chunk can hold millions of tiny malformed
 * lines, so emitting one warning PER line would blow the reader's per-scan work budget
 * with synchronous listener fan-outs (PRD §9.2). Instead a pass COALESCES drops to one
 * live warning per (path, cause) — the incident is still surfaced, but delivery is
 * bounded regardless of how many lines dropped. The reporter is neither reset nor
 * counted across passes, so this is not a persisted aggregate.
 */

import type { DropCause } from "../warnings/reasons.ts";

export type { DropCause };

/** A bounded, content-free notice that committed transcript data was lost. */
export type TranscriptDropNotice = {
  readonly elwoodSessionId: string;
  readonly path: string;
  /** The cause of this loss (never content): unparseable / oversized / backlog. */
  readonly cause: DropCause;
};

/** A bounded, content-free notice that a transcript filesystem read failed. */
export type TranscriptReadErrorNotice = {
  readonly elwoodSessionId: string;
  readonly path: string;
  /** The error's code (e.g. "ENOENT", "EISDIR"), for diagnosis (never content). */
  readonly lastErrorCode: string;
};

/**
 * Coalesces lost records into ONE live drop warning per (path, cause) per scan pass.
 * A pass accumulates distinct (path, cause) incidents; `flushPass()` delivers each
 * once and clears the pass, so a chunk of a million malformed lines yields a bounded
 * number of warning fan-outs, not a million.
 */
export class DropReporter {
  private readonly elwoodSessionId: string;
  private readonly onDrop: ((notice: TranscriptDropNotice) => void) | undefined;
  // Per-path set of distinct causes seen in the CURRENT (un-flushed) pass. Indexed by
  // the path string ITSELF (a Map key that already exists) rather than a composite
  // `path|cause` string: a 4 MiB chunk of tiny malformed lines re-records the same
  // (path, cause) millions of times, and rebuilding a composite key each time would
  // churn path-length-proportional garbage. A small cause Set per path is free to re-hit.
  private readonly pending = new Map<string, Set<DropCause>>();

  constructor(
    elwoodSessionId: string,
    onDrop: ((notice: TranscriptDropNotice) => void) | undefined,
  ) {
    this.elwoodSessionId = elwoodSessionId;
    this.onDrop = onDrop;
  }

  /** Record one unparseable committed record (coalesced until the pass flushes). */
  record(path: string): void {
    this.drop(path, "unparseable");
  }

  /** Record one lost record/backlog under `cause` (coalesced until the pass flushes). */
  drop(path: string, cause: DropCause): void {
    if (this.onDrop === undefined) return;
    const causes = this.pending.get(path);
    if (causes === undefined) this.pending.set(path, new Set([cause]));
    else causes.add(cause); // Set.add is a no-op if already surfacing this (path, cause)
  }

  /** Deliver each coalesced (path, cause) incident once, then clear the pass. */
  flushPass(): void {
    if (this.pending.size === 0) return;
    const pending = [...this.pending];
    this.pending.clear(); // clear FIRST so a throwing listener cannot re-fire the batch
    for (const [path, causes] of pending) {
      for (const cause of causes) {
        this.onDrop?.({ elwoodSessionId: this.elwoodSessionId, path, cause });
      }
    }
  }

  /**
   * Discard this pass's coalesced incidents WITHOUT delivering — used when the watcher
   * finished mid-poll, so nothing is emitted past the terminal:exit latch (§5.4).
   */
  discardPass(): void {
    this.pending.clear();
  }
}

/** Emits ONE live read-error warning per contained fs error for one watcher. */
export class ReadErrorReporter {
  private readonly elwoodSessionId: string;
  private readonly onError: ((notice: TranscriptReadErrorNotice) => void) | undefined;

  constructor(
    elwoodSessionId: string,
    onError: ((notice: TranscriptReadErrorNotice) => void) | undefined,
  ) {
    this.elwoodSessionId = elwoodSessionId;
    this.onError = onError;
  }

  record(path: string, error: unknown): void {
    // `code` is only a string on a real errno; a non-string (e.g. a numeric `code`)
    // must NOT surface as `lastErrorCode`, whose public type is a string.
    const code = (error as { code?: unknown } | null)?.code;
    const lastErrorCode = typeof code === "string" ? code : "UNKNOWN";
    this.onError?.({ elwoodSessionId: this.elwoodSessionId, path, lastErrorCode });
  }
}
