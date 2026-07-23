/**
 * Content-free, live-only accounting of transcript observation problems shared by
 * both adapters: lost committed data (drops) and contained filesystem read errors.
 * Implements PRD §5.4 (C-CLAUDE-15 / §7A): a malformed record, an over-length record,
 * an unread teardown backlog, or a transient fs error is surfaced as ONE live warning
 * carrying only its path and a bounded cause/error-code — never raw content, never a
 * running count. A human at the terminal sees each problem once, live; Elwood mirrors
 * that (no persistence, no aggregate, no cross-resume continuation).
 */

import type { DropCause } from "../warning-reasons.ts";

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

/** Emits ONE live drop warning per lost record/backlog for one watcher. */
export class DropTracker {
  private readonly elwoodSessionId: string;
  private readonly onDrop: ((notice: TranscriptDropNotice) => void) | undefined;

  constructor(
    elwoodSessionId: string,
    onDrop: ((notice: TranscriptDropNotice) => void) | undefined,
  ) {
    this.elwoodSessionId = elwoodSessionId;
    this.onDrop = onDrop;
  }

  /** Surface one unparseable committed record as a live drop warning. */
  record(path: string): void {
    this.drop(path, "unparseable");
  }

  /** Surface one lost record/backlog under `cause` as a live drop warning. */
  drop(path: string, cause: DropCause): void {
    this.onDrop?.({ elwoodSessionId: this.elwoodSessionId, path, cause });
  }
}

/** Emits ONE live read-error warning per contained fs error for one watcher. */
export class ReadErrorTracker {
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
