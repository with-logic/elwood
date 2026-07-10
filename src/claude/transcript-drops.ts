/**
 * Rate-bounded, content-free accounting of unparseable transcript records.
 * Implements PRD §5.4 (C-CLAUDE-15): a malformed committed record is dropped
 * but surfaced as a running count and byte magnitude — never its raw content.
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

/** Emit a drop notice at most once per this many dropped records (rate-bounded). */
const dropNoticeEvery = 50;

/** Tracks drops for one watcher and rate-bounds the notices it forwards. */
export class DropTracker {
  private dropped = 0;
  private droppedBytes = 0;
  private notifiedAt = 0;
  private lastDropPath = "";
  private readonly elwoodSessionId: string;
  private readonly onDrop: ((notice: TranscriptDropNotice) => void) | undefined;

  constructor(
    elwoodSessionId: string,
    onDrop: ((notice: TranscriptDropNotice) => void) | undefined,
  ) {
    this.elwoodSessionId = elwoodSessionId;
    this.onDrop = onDrop;
  }

  /** Count a dropped line, notifying on the first drop and then every N. */
  record(path: string, line: string): void {
    this.dropped += 1;
    this.droppedBytes += Buffer.byteLength(line, "utf8");
    this.lastDropPath = path;
    if (this.dropped - this.notifiedAt >= dropNoticeEvery || this.notifiedAt === 0) {
      this.notify(path);
    }
  }

  /** Emit a final aggregated notice for any drops not yet reported. */
  flush(): void {
    if (this.dropped > this.notifiedAt) this.notify(this.lastDropPath);
  }

  private notify(path: string): void {
    this.notifiedAt = this.dropped;
    this.onDrop?.({
      elwoodSessionId: this.elwoodSessionId,
      path,
      droppedCount: this.dropped,
      droppedBytes: this.droppedBytes,
    });
  }
}
