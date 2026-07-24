/**
 * Serializes ergonomic turns in CALL order (PRD §5.8, C-API-50). A turn's slot is reserved
 * SYNCHRONOUSLY when `enqueue` is called (not when the generator is iterated), so
 * `stream("a"); stream("b")` submits a before b even if b is consumed first. Each turn holds
 * its slot until its REAL boundary (the runner's `completion`), so a consumer that abandons
 * a stream early never lets the next turn bind to this turn's still-arriving trailing events.
 */

import type { TurnEvent } from "./events.ts";
import type { RunningTurn } from "./turn.ts";

export class TurnQueue {
  // The tail of the serialized-turn chain: each turn awaits the previous one's real boundary.
  private tail: Promise<unknown> = Promise.resolve();

  /**
   * Reserve a serialized slot now and return the turn's consumer generator. The turn STARTS
   * (via `run`) as soon as the predecessor settles — EAGERLY, independent of whether the
   * consumer iterates — so a turn whose consumer is not yet reading still runs in call order
   * and does not deadlock a later turn that IS being consumed. The slot is held until the
   * turn's real `completion`; the returned generator only reads the started turn's events.
   */
  enqueue(run: () => Promise<RunningTurn>): AsyncGenerator<TurnEvent> {
    const predecessor = this.tail;
    let releaseSlot!: () => void;
    this.tail = new Promise<void>((resolve) => {
      releaseSlot = resolve;
    });
    // Start the turn as its slot comes up, decoupled from consumption. The predecessor's tail
    // ALWAYS resolves (a failed turn still releases its slot below), so a prior turn's failure
    // never blocks a later turn. Hold this slot until the agent turn's real boundary, then
    // release it — even if start rejected (nothing to hold, but the chain must not wedge).
    const started = predecessor.then(() => run());
    void started.then(
      // `runTurn`'s completion ALWAYS resolves (it never re-throws — the turn error reaches the
      // consumer via the events generator), so releasing on it never leaves the chain wedged.
      (turn) => turn.completion.then(releaseSlot),
      () => releaseSlot(), // `run()` (i.e. session start) rejected: nothing to hold, free the slot
    );
    return drainStarted(started);
  }
}

/** Yield the (eagerly-started) turn's events once it has started; propagates a start failure. */
async function* drainStarted(started: Promise<RunningTurn>): AsyncGenerator<TurnEvent> {
  const turn = await started; // rejects if session start / run() failed — surfaced to the consumer
  yield* turn.events;
}
