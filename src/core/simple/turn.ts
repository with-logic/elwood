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
 * The runner is DECOUPLED from the consumer generator. Its `completion` promise ALWAYS
 * resolves (the turn's error, if any, reaches the consumer via `events`), signalling only that
 * the CONSUMER has settled. The serializer instead holds its slot on the separate `boundary`
 * promise, which resolves only when the AGENT genuinely settles — the gate's successful end
 * (oracle/quiet, i.e. the transcript drained) or a terminal status, NOT bare `ready` (Claude
 * transcript activity arrives after `ready`) and NOT a consumer failure while the agent runs.
 * So abandoning or timing out a stream can never release the slot while the agent is still
 * producing, which would let the next turn bind to this turn's trailing (untagged) events.
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
 * boundary. Returns the consumer `events` generator, an always-resolving `completion` signal,
 * and the `boundary` promise the serializer holds its slot on (so the next turn never starts
 * before the AGENT settles — see `RunningTurn` and the file docstring).
 */
export function runTurn(
  session: TurnSession,
  prompt: string,
  options: StreamTurnOptions = {},
): RunningTurn {
  const catchUpMs = options.catchUpMs ?? CATCH_UP_MS;
  const gate = new TurnGate(
    options.fallbackQuietMs ?? FALLBACK_QUIET_MS,
    catchUpMs,
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
  let consumerSettled = false;
  let consumerFailed = false;

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
    armPostFailQuiet(); // post-failure transcript flush is still activity — defers the quiet boundary
  });
  const offHook = session.on("hook", (event) => {
    // The Stop hook is the turn boundary and carries the expected final assistant text.
    // Used as a completeness ORACLE only (never displayed — respects C-CLAUDE-15).
    if (event.hook_event_name === "Stop")
      gate.expectText(event.last_assistant_message ?? undefined);
  });
  // The REAL agent boundary — the point past which a NEXT turn can safely start. It is NOT bare
  // `ready`: Claude transcript activity arrives AFTER `ready`, so releasing there would let the
  // next turn bind to this turn's still-arriving (untagged) activity. It is instead the moment
  // the turn GENUINELY settles — the gate's successful `end()` (oracle matched / quiet window
  // elapsed / terminal), i.e. the transcript has drained — or a terminal status. On a
  // consumer-facing FAILURE (timeout/catch-up/backlog) the agent may still be flushing, so the
  // boundary is deferred: a terminal status, or a sustained post-failure quiet window, releases it.
  let resolveBoundary!: () => void;
  const boundary = new Promise<void>((resolve) => {
    resolveBoundary = resolve;
  });
  let boundaryReached = false;
  let postFailQuietTimer: ReturnType<typeof setTimeout> | undefined;
  const reachBoundary = () => {
    if (boundaryReached) return;
    boundaryReached = true;
    if (postFailQuietTimer) clearTimeout(postFailQuietTimer);
    resolveBoundary();
    maybeCleanup();
  };
  // After a consumer failure the gate is dead but the agent's transcript may still be draining;
  // re-arm a quiet window on each further activity/status so the boundary lands once it stops.
  const armPostFailQuiet = () => {
    if (boundaryReached || !consumerFailed) return;
    if (postFailQuietTimer) clearTimeout(postFailQuietTimer);
    postFailQuietTimer = setTimeout(reachBoundary, catchUpMs);
    postFailQuietTimer.unref?.();
  };
  // The gate's SUCCESSFUL settle (oracle matched / quiet window / terminal end) means the
  // transcript has drained — the real boundary. Its rejection (a consumer failure) does NOT
  // resolve the boundary here; the post-fail quiet watcher / a terminal status does.
  gate.done().then(reachBoundary, () => undefined);

  const offStatus = session.on("status", ({ status }) => {
    if (status === "running") started = true;
    if (terminalStatuses.has(status)) {
      gate.end();
      return reachBoundary(); // agent is gone — the real boundary, regardless of consumer state
    }
    if (status === "ready" && started) gate.settle(); // begins oracle/quiet checks; boundary waits
    armPostFailQuiet(); // a post-failure status still counts as activity for the quiet watcher
  });

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
    } catch (error) {
      // The SUBMISSION itself failed, so NO agent turn is in flight and no status transition is
      // coming: fail the consumer with the typed error AND reach the boundary at once (else the
      // serializer waits forever). A terminal-status race is a benign idempotent no-op (buffered
      // events stand); otherwise a submit-on-a-dead-session `session_not_running` propagates to
      // the consumer (C-API-25) — a typed `ElwoodError` the adapter threw, not a duck-typed shape.
      gate.fail(toError(error));
      reachBoundary();
      consumerSettled = true;
      maybeCleanup();
      return;
    }
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(
        () => gate.fail(elwoodError("wait_timeout", "turn timed out")),
        options.timeoutMs,
      );
    }
    try {
      await gate.done(); // resolves on genuine settle (→ boundary); rejects on consumer failure
    } catch {
      // A consumer failure (timeout/catch-up/backlog) AFTER submission: the agent turn ran and may
      // still be flushing its transcript, so the boundary is NOT reached now. Mark the failure and
      // arm the post-fail quiet watcher — a later terminal status or a sustained quiet window
      // releases the serialized slot, so the next turn never binds to this turn's trailing activity.
      consumerFailed = true;
      armPostFailQuiet();
    } finally {
      if (timer) clearTimeout(timer);
      consumerSettled = true;
      maybeCleanup();
    }
  })();

  return { events: gate.drain(), completion, boundary };
}
