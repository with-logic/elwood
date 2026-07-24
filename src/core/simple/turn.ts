/**
 * One ergonomic turn: submit a prompt and drive the agent turn to its REAL boundary,
 * feeding a gate the consumer reads (PRD §5.8, C-API-48/49/50).
 *
 * The turn boundary is a COMPLETENESS ORACLE, not a timer. A turn's assistant text is
 * transcript-sourced (C-CLAUDE-15) and the transcript is written ASYNCHRONOUSLY, arriving
 * shortly AFTER the `ready` status. The turn-boundary `Stop` hook carries
 * `last_assistant_message` — the final assistant text of the just-completed turn — used
 * ONLY as a completeness signal (never displayed — it can be ghost text): the turn ends
 * once the transcript-collected assistant text CONTAINS it. With no such signal (a
 * pure-tool turn, or an empty/`null` `last_assistant_message`) the turn ends after a
 * bounded quiet window with no new content.
 *
 * The runner is DECOUPLED from the consumer generator: it runs eagerly to the real turn
 * boundary and its `completion` promise resolves only THEN, so a consumer that abandons
 * the stream early cannot release the turn's serialized slot while the agent is still
 * running (which would let the next turn bind to this turn's trailing events).
 *
 * Timeouts: a turn may run for HOURS (a test suite, a PR poll), so there is NO whole-turn
 * timeout by default; callers may pass an opt-in `timeoutMs`, armed only AFTER submission (a
 * turn begins on submission — the timer must never reject a caller for a prompt still queued
 * behind readiness that then submits anyway). The tight cap is `catchUpMs` (default 10s),
 * armed only ONCE `ready` fires — the flush should be near-instant, so a longer stall rejects
 * with `wait_timeout`. A terminal status ends the turn at once.
 */

import { elwoodError, toError } from "../errors.ts";
import { terminalStatuses } from "../status-categories.ts";
import { toTurnEvent } from "./events.ts";
import { TurnGate } from "./turn-gate.ts";
import type { RunningTurn, StreamTurnOptions, TurnSession } from "./turn-types.ts";

export type {
  AssertStopBoundary,
  RunningTurn,
  StreamTurnOptions,
  TurnBoundaryContract,
  TurnBoundaryHook,
  TurnSession,
} from "./turn-types.ts";

/** Quiet window (ms) after `ready` for a no-oracle turn to settle once content stops. */
const FALLBACK_QUIET_MS = 750;
/** Cap (ms) on the POST-`ready` transcript catch-up: a stalled flush bails, not hangs. */
const CATCH_UP_MS = 10_000;

/**
 * Start a turn: attach listeners, submit the prompt, and drive the gate to the turn's real
 * boundary. Returns the consumer `events` generator and a `completion` promise that the
 * serializer holds its slot on (so the next turn never starts before this one settles).
 */
export function runTurn(
  session: TurnSession,
  prompt: string,
  options: StreamTurnOptions = {},
): RunningTurn {
  const gate = new TurnGate(
    options.fallbackQuietMs ?? FALLBACK_QUIET_MS,
    options.catchUpMs ?? CATCH_UP_MS,
    options.maxPendingEvents,
    options.maxPendingBytes,
  );
  let turnId: string | undefined;
  let bound = false;
  // The turn only ENDS on a settle once it has demonstrably STARTED — a `running` status or
  // the first content event — so the idle `ready` the session sits at when the prompt is
  // submitted does not end the turn before any work runs. This (with the serializer holding
  // the prior turn to its real boundary before this one starts) is why no explicit
  // "is this my submission" gate is needed: there are no prior-turn events left to mis-collect.
  let started = false;

  const offActivity = session.on("activity", (event) => {
    const simple = toTurnEvent(event);
    if (!bound && simple) {
      bound = true;
      started = true;
      turnId = event.turnId;
    }
    if (simple && (event.turnId === undefined || event.turnId === turnId)) {
      // Queue the event FIRST, then feed the oracle: observeText can end() the turn, and
      // push() drops events once ended — so the text that COMPLETES the turn is enqueued
      // before the completion check runs.
      gate.push(simple);
      if (simple.type === "text") gate.observeText(simple.text);
    }
  });
  const offHook = session.on("hook", (event) => {
    // The Stop hook is the turn boundary and carries the expected final assistant text.
    // Used as a completeness ORACLE only (never displayed — respects C-CLAUDE-15).
    if (event.hook_event_name === "Stop")
      gate.expectText(event.last_assistant_message ?? undefined);
  });
  // The REAL agent boundary: resolves on a terminal status, or a `ready` after the turn started.
  // It is INDEPENDENT of the consumer gate — a consumer-facing failure (timeout, catch-up,
  // backlog) does NOT resolve it, so the serializer keeps this turn's slot until the agent
  // genuinely settles and can never let the next turn bind to this turn's still-arriving activity.
  let resolveBoundary!: () => void;
  const boundary = new Promise<void>((resolve) => {
    resolveBoundary = resolve;
  });
  let boundaryReached = false;
  const reachBoundary = () => {
    if (boundaryReached) return;
    boundaryReached = true;
    resolveBoundary();
    maybeCleanup();
  };

  const offStatus = session.on("status", ({ status }) => {
    if (status === "running") started = true;
    if (terminalStatuses.has(status)) {
      gate.end();
      return reachBoundary(); // agent is gone — the real boundary, regardless of consumer state
    }
    if (status === "ready" && started) {
      gate.settle();
      reachBoundary(); // the agent completed a turn (reached ready after starting) — real boundary
    }
  });

  let consumerSettled = false;
  // Listeners are removed only once BOTH the consumer has settled AND the real boundary is
  // reached: the boundary observer must outlive a consumer failure (a timed-out turn whose agent
  // is still running), and the consumer view must outlive an early boundary (buffered drain).
  const maybeCleanup = () => {
    if (!(consumerSettled && boundaryReached)) return;
    gate.dispose();
    offActivity();
    offHook();
    offStatus();
  };

  // Drive the consumer lifecycle EAGERLY and independently of iteration: submit, then wait for
  // the gate to settle. Always resolves — the turn error reaches the consumer via `events`.
  const completion = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // A turn BEGINS on submission (PRD §5.8), so the opt-in whole-turn ceiling is armed only
      // AFTER `sendMessage` resolves — never rejecting a prompt still queued behind readiness
      // that then submits. Pre-submission wait is bounded by the queue's readiness semantics.
      await session.sendMessage(prompt); // listeners attached — no early event lost
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(
          () => gate.fail(elwoodError("wait_timeout", "turn timed out")),
          options.timeoutMs,
        );
      }
      await gate.done(); // rejects on fail/timeout — the error is already recorded for `drain`
    } catch (error) {
      // The SUBMISSION itself failed, so no agent turn is in flight and no status transition is
      // coming for it: fail the consumer with the typed error AND reach the boundary (else the
      // serializer waits forever). If a terminal status already ended the gate (a benign race),
      // `gate.fail`/`reachBoundary` are idempotent no-ops and the buffered events stand;
      // otherwise a submit-on-a-dead-session `session_not_running` propagates to the consumer
      // (C-API-25) — a typed `ElwoodError` the adapter already threw, not a duck-typed shape.
      gate.fail(toError(error));
      reachBoundary();
    } finally {
      if (timer) clearTimeout(timer);
      consumerSettled = true;
      maybeCleanup();
    }
  })();

  return { events: gate.drain(), completion, boundary };
}
