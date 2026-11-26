/**
 * Messages queued during a running Claude turn (PRD §5.4, C-API-62; §6.5, C-HOOK-24). Claude fires
 * a queued message's `UserPromptSubmit` with the running turn's prompt ID. When an interrupt cancels
 * that screening, Claude fires it again under a new prompt ID as it runs the message as its own turn.
 * A queued message stays pending until that second hook claims it or the transcript shows its
 * delivery: a `remove` queue operation inside the turn, or a `queued` user record as Claude starts
 * a new turn for it, with or without a second hook. A queued repeat of a prompt transcript recovery
 * showed is hidden at its first hook, so its second hook shows it. Entries are prompt text digests at increasing
 * positions, so a `Stop` holds only for messages queued since the previous `Stop`, and forgets only
 * those queued before it. A message the caller's handler blocked stays claimable by a second hook,
 * but Claude never runs it, so it holds no `Stop`. The newest live `dequeue` record's timestamp,
 * pending or not, tells a `Stop` whether Claude started a queued turn after it, even when the record
 * is read late behind a transcript backlog.
 */
import { isRecord } from "../../core/predicates.ts";
import { textDigest } from "./prompt-keys.ts";
import { userPromptRecord } from "./user-record.ts";

/** At most this many queued messages stay pending (PRD §5.4). */
const maxQueuedPrompts = 64;

/** The positions a `Stop` may hold for: from the previous `Stop` up to this one. */
export type QueuedPromptsWindow = { readonly from: number; readonly to: number };

/** The operations a `Stop` and the hook handler use while Claude may start a queued turn. */
export type QueuedPromptsAccess = Pick<
  ClaudeQueuedPrompts,
  "dequeuedSince" | "nextPosition" | "takeStopWindow" | "hasRunnableIn" | "forgetBefore" | "block"
>;

type Pending = {
  readonly digest: string;
  readonly position: number;
  readonly blocked: boolean;
  /** Whether its hook showed it. A hidden repeat of a recovered prompt is shown when re-screened. */
  readonly shown: boolean;
};

export class ClaudeQueuedPrompts {
  private readonly pending: Pending[] = [];
  private positions = 0;
  private lastStop = 0;
  private newestDequeueAtMs = Number.NEGATIVE_INFINITY;

  get isEmpty(): boolean {
    return this.pending.length === 0;
  }

  /** Whether Claude stamped a live `dequeue` record, as it started a queued turn, at or after the
   * cutoff, in epoch milliseconds. */
  dequeuedSince(cutoffAtMs: number): boolean {
    return this.newestDequeueAtMs >= cutoffAtMs;
  }

  /** The position the next queued message takes. */
  get nextPosition(): number {
    return this.positions;
  }

  /** Called once per `Stop`: takes the window of messages queued since the previous `Stop`. */
  takeStopWindow(): QueuedPromptsWindow {
    const window = { from: this.lastStop, to: this.positions };
    this.lastStop = window.to;
    return window;
  }

  /** Whether the window holds a pending message Claude may still run: one the handler did not block. */
  hasRunnableIn(window: QueuedPromptsWindow): boolean {
    return this.pending.some(
      (entry) => !entry.blocked && entry.position >= window.from && entry.position < window.to,
    );
  }

  forgetBefore(position: number): void {
    while ((this.pending[0]?.position ?? position) < position) this.pending.shift();
  }

  /** The caller's handler blocked this prompt's `UserPromptSubmit`, which queued it here if anywhere. */
  block(position: number | undefined, prompt: string): void {
    const digest = textDigest(prompt);
    const index = this.pending.findIndex(
      (entry) => entry.position === position && entry.digest === digest,
    );
    const entry = this.pending[index];
    if (entry) this.pending[index] = { ...entry, blocked: true };
  }

  queued(digest: string, shown = true): void {
    this.pending.push({ digest, position: this.positions++, blocked: false, shown });
    if (this.pending.length > maxQueuedPrompts) this.pending.shift();
  }

  /** Only a live record of the main transcript can show Claude starting a queued turn here. */
  observeRecord(item: unknown, liveMainConversation: boolean): void {
    if (!isRecord(item)) return;
    if (
      liveMainConversation &&
      item["type"] === "queue-operation" &&
      item["operation"] === "dequeue"
    )
      this.newestDequeueAtMs = Math.max(
        this.newestDequeueAtMs,
        recordTimestampMs(item["timestamp"]),
      );
    if (this.isEmpty) return;
    const delivered =
      item["type"] === "queue-operation"
        ? item["operation"] === "remove" && item["content"]
        : item["promptSource"] === "queued" && userPromptRecord(item)?.text;
    if (typeof delivered === "string") this.claim(textDigest(delivered));
  }

  clear(): void {
    this.pending.length = 0;
  }

  /** Claims a pending message with this text digest. Returns whether one was, and its hook showed it. */
  claim(digest: string): boolean {
    const index = this.pending.findIndex((entry) => entry.digest === digest);
    const claimed = this.pending[index];
    if (claimed === undefined) return false;
    this.pending.splice(index, 1);
    return claimed.shown;
  }
}

/** A record's stamp in epoch milliseconds. An unparseable one counts as the time Elwood read it. */
function recordTimestampMs(timestamp: unknown): number {
  const at = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
  return Number.isNaN(at) ? Date.now() : at;
}
