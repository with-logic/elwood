/**
 * Rate-bounded, content-free accounting of transcript observation problems:
 * unparseable committed records (drops) and contained filesystem read errors.
 * Implements PRD §5.4 (C-CLAUDE-15): a malformed record or a transient fs error
 * is surfaced as a running count and byte/kind magnitude — never raw content.
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

/** Notify on the first event and then at most once per this many, not per event. */
const noticeEvery = 50;

/** A rate-bounded counter that forwards at most one notice per `noticeEvery` events. */
class RateBounded {
  protected count = 0;
  private notifiedAt = 0;

  /** True when this event should produce a notice (first, then every N). */
  protected shouldNotify(): boolean {
    return this.count - this.notifiedAt >= noticeEvery || this.notifiedAt === 0;
  }

  protected markNotified(): void {
    this.notifiedAt = this.count;
  }

  protected pending(): boolean {
    return this.count > this.notifiedAt;
  }
}

/** Tracks unparseable records for one watcher and rate-bounds the notices. */
export class DropTracker extends RateBounded {
  private droppedBytes = 0;
  private lastDropPath = "";
  private readonly elwoodSessionId: string;
  private readonly onDrop: ((notice: TranscriptDropNotice) => void) | undefined;

  constructor(
    elwoodSessionId: string,
    onDrop: ((notice: TranscriptDropNotice) => void) | undefined,
  ) {
    super();
    this.elwoodSessionId = elwoodSessionId;
    this.onDrop = onDrop;
  }

  record(path: string, line: string): void {
    this.recordBytes(path, Buffer.byteLength(line, "utf8"));
  }

  /** Count one dropped record contributing `bytes` (an over-length line already measured). */
  recordBytes(path: string, bytes: number): void {
    this.count += 1;
    this.droppedBytes += bytes;
    this.lastDropPath = path;
    if (this.shouldNotify()) this.notify(path);
  }

  flush(): void {
    if (this.pending()) this.notify(this.lastDropPath);
  }

  private notify(path: string): void {
    this.markNotified();
    this.onDrop?.({
      elwoodSessionId: this.elwoodSessionId,
      path,
      droppedCount: this.count,
      droppedBytes: this.droppedBytes,
    });
  }
}

/** Tracks contained filesystem read errors for one watcher and rate-bounds them. */
export class ReadErrorTracker extends RateBounded {
  private lastCode = "";
  private lastPath = "";
  private readonly elwoodSessionId: string;
  private readonly onError: ((notice: TranscriptReadErrorNotice) => void) | undefined;

  constructor(
    elwoodSessionId: string,
    onError: ((notice: TranscriptReadErrorNotice) => void) | undefined,
  ) {
    super();
    this.elwoodSessionId = elwoodSessionId;
    this.onError = onError;
  }

  record(path: string, error: unknown): void {
    this.count += 1;
    this.lastCode = (error as NodeJS.ErrnoException)?.code ?? "UNKNOWN";
    this.lastPath = path;
    if (this.shouldNotify()) this.notify();
  }

  flush(): void {
    if (this.pending()) this.notify();
  }

  private notify(): void {
    this.markNotified();
    this.onError?.({
      elwoodSessionId: this.elwoodSessionId,
      path: this.lastPath,
      errorCount: this.count,
      lastErrorCode: this.lastCode,
    });
  }
}
