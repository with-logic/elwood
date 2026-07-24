/**
 * One ergonomic turn: submit a prompt and stream its simplified content events until the
 * session settles (PRD §5.8, C-API-48/49). Subscribes to `activity` BEFORE submitting so
 * no early event is missed, binds collection to the turn's `turnId` so a queued prior
 * turn cannot bleed in, and ends when the session reaches `ready` or a terminal status
 * (or the deadline throws `wait_timeout`).
 */

import type { ElwoodAgentSession } from "../agent-session.ts";
import { elwoodError } from "../errors.ts";
import { terminalStatuses } from "../status-categories.ts";
import { type SimpleTurnEvent, toSimpleTurnEvent } from "./events.ts";

/** The narrow session surface a turn drives (satisfied by any Elwood session). */
export type TurnSession = Pick<ElwoodAgentSession, "on" | "status" | "sendMessage">;

const DEFAULT_TURN_TIMEOUT_MS = 300_000;
/** Quiet window after a `ready` settle for trailing transcript-sourced content to flush. */
const SETTLE_GRACE_MS = 750;

/**
 * Runs one turn as an async generator of simplified events. The prompt is submitted after
 * the activity listener is attached; the turn ends when the session next settles to
 * `ready` (having started) or reaches a terminal status. A turn's events are those whose
 * `turnId` matches the first content event seen after submit; events with no `turnId`
 * (some adapters omit it) are attributed to the sole in-flight turn.
 */
export async function* streamTurn(
  session: TurnSession,
  prompt: string,
  timeoutMs = DEFAULT_TURN_TIMEOUT_MS,
  settleGraceMs = SETTLE_GRACE_MS,
): AsyncGenerator<SimpleTurnEvent> {
  const gate = new TurnGate();
  let turnId: string | undefined;
  let bound = false;
  // The turn only ENDS on a settle once it has demonstrably STARTED — a `running` status
  // or the first content event. Otherwise the idle `ready` the session sits at when the
  // prompt is submitted would end the turn before any work ran.
  let started = false;
  const offActivity = session.on("activity", (event) => {
    const simple = toSimpleTurnEvent(event);
    // Bind to the first content event's turn; thereafter accept only that turn's events
    // (an event with no turnId belongs to the single in-flight turn).
    if (!bound && simple) {
      bound = true;
      started = true;
      turnId = event.turnId;
    }
    if (simple && (event.turnId === undefined || event.turnId === turnId)) gate.push(simple);
  });
  const offStatus = session.on("status", ({ status }) => {
    if (status === "running") started = true;
    // A terminal status is FINAL — end at once. A `ready` settle ends after a brief quiet
    // grace: assistant text is transcript-sourced and can arrive just AFTER `ready`, so a
    // trailing content event within the grace window defers the end (see gate.softEnd).
    if (terminalStatuses.has(status)) return gate.end();
    if (status === "ready" && started) gate.softEnd(settleGraceMs);
  });
  const timer = setTimeout(
    () => gate.fail(elwoodError("wait_timeout", "turn timed out")),
    timeoutMs,
  );
  try {
    // Submit AFTER listeners are attached. A settle can only end the turn once we have
    // left `ready`, so arm the gate before the post-submit `ready` is observed.
    await session.sendMessage(prompt);
    yield* gate.drain();
  } finally {
    clearTimeout(timer);
    offActivity();
    offStatus();
  }
}

/**
 * A single-producer/single-consumer async gate: event callbacks `push`/`end`/`fail`, the
 * generator `drain`s. Ready before the turn's first settle so a fast turn cannot end
 * before draining starts — `end()` before the consumer arrives is remembered.
 */
class TurnGate {
  private readonly queue: SimpleTurnEvent[] = [];
  private ended = false;
  private error: unknown;
  private wake: (() => void) | undefined;
  private graceTimer: ReturnType<typeof setTimeout> | undefined;
  private graceMs: number | undefined;

  push(event: SimpleTurnEvent): void {
    if (this.ended) return;
    this.queue.push(event);
    // A content event within the settle grace means the turn is still producing: RE-ARM
    // the quiet window from now, so trailing text keeps the turn open but a lasting quiet
    // still ends it (a plain cancel would hang if this were the final event).
    if (this.graceMs !== undefined) this.armGrace(this.graceMs);
    this.wake?.();
  }
  end(): void {
    // Latch completion; drain() finishes only once the queue is also empty, so a settle
    // racing ahead of the last buffered content event never truncates the turn.
    this.clearGrace();
    this.ended = true;
    this.wake?.();
  }
  /** End after `graceMs` of quiet; a content event re-arms the window (see push). */
  softEnd(graceMs: number): void {
    if (this.ended) return;
    this.graceMs = graceMs;
    this.armGrace(graceMs);
  }
  fail(error: unknown): void {
    this.clearGrace();
    this.error = error;
    this.ended = true;
    this.wake?.();
  }
  private armGrace(graceMs: number): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = setTimeout(() => this.end(), graceMs);
    this.graceTimer.unref?.();
  }
  private clearGrace(): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = undefined;
    this.graceMs = undefined;
  }
  async *drain(): AsyncGenerator<SimpleTurnEvent> {
    for (;;) {
      while (this.queue.length > 0) yield this.queue.shift() as SimpleTurnEvent;
      if (this.error !== undefined) throw this.error;
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }
}
