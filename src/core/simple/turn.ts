/**
 * One ergonomic turn: submit a prompt and drive the agent turn to its REAL boundary,
 * feeding a gate the consumer reads (PRD §5.8, C-API-48/49/50).
 *
 * The turn boundary is a COMPLETENESS ORACLE, not a timer. A turn's assistant text is
 * transcript-sourced (C-CLAUDE-15) and written ASYNCHRONOUSLY, arriving shortly AFTER `ready`.
 * The `Stop` hook's `last_assistant_message` is used ONLY as a completeness signal (never
 * displayed — it can be ghost text): the turn ends once the collected text CONTAINS it. With no
 * such signal (a pure-tool turn, or an empty/`null` value) it ends after a bounded quiet window.
 *
 * Completeness is separate from FAILURE: a turn the agent REJECTED fails with `turn_failed` on
 * the adapter's own evidence (C-API-57), never the absence of text (§12A.3).
 *
 * The runner is decoupled from its consumer: `completion` resolves when the consumer settles and
 * its error travels through `events`. The serializer instead holds `boundary`, which resolves on
 * a successful oracle/quiet settle or terminal status. After consumer failure it waits for real
 * `ready`/terminal evidence plus transcript drain, so abandoned streams cannot release their slot
 * while the agent is still producing — except an AGENT REJECTION, which ended the turn by
 * refusing it and so reaches the boundary AT ONCE (C-API-57).
 *
 * Timeouts and their rationale live with the constants in `turn-defaults.ts`. In short: no
 * whole-turn timeout by default, an opt-in `timeoutMs` armed only after submission, and a
 * `catchUpMs` cap armed once `ready` fires. A terminal status ends the turn at once.
 */

import { toError } from "../errors.ts";
import { terminalStatuses } from "../status-categories.ts";
import {
  activityFailure,
  boundaryExpectation,
  rejectTurn,
  signalFailure,
} from "./boundary-signal.ts";
import { toTurnEvent } from "./events.ts";
import { TurnAcceptance } from "./turn-acceptance.ts";
import { TurnBoundary } from "./turn-boundary.ts";
import { armTurnTimeout, FALLBACK_QUIET_MS, gateForTurn } from "./turn-defaults.ts";
import {
  defaultAcceptanceSignal,
  defaultBoundarySignal,
  noFailureEvidence,
  type RunningTurn,
  type StreamTurnOptions,
  type TurnSession,
} from "./turn-types.ts";

export type {
  AcceptanceSignalReader,
  AssertStopBoundary,
  BoundarySignalReader,
  RunningTurn,
  StreamTurnOptions,
  TurnBoundaryContract,
  TurnBoundaryHook,
  TurnSession,
} from "./turn-types.ts";
export { defaultAcceptanceSignal, defaultBoundarySignal } from "./turn-types.ts";

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
  const gate = gateForTurn(options);
  const sendOptions = options.images === undefined ? undefined : { images: options.images };
  const send = () => session.sendMessage(prompt, sendOptions);
  const acceptance = new TurnAcceptance(options.fallbackQuietMs ?? FALLBACK_QUIET_MS, {
    replay: send,
    acceptReady: () => gate.observeReady(),
    fail: (error) => gate.fail(toError(error)),
  });
  // Bound to the first content event that CARRIES a `turnId` (Codex tags; Claude never does);
  // untagged events always belong to this turn, a differently tagged one is a prior turn's.
  let turnId: string | undefined;
  // The turn only ENDS on a settle once it has demonstrably STARTED — a `running` status or
  // the first content event — so the idle `ready` the session sits at when the prompt is
  // submitted does not end the turn before any work runs. This (with the serializer holding
  // the prior turn to its real boundary before this one starts) is why no explicit
  // "is this my submission" gate is needed: there are no prior-turn events left to mis-collect.
  let started = false;
  let sawReady = false; // a `ready` after the turn started was observed (agent turn is idle/done)
  let consumerSettled = false;

  // Listeners are removed only once BOTH the consumer settled AND the real boundary is reached:
  // the boundary observer must outlive a consumer failure (a timed-out turn whose agent still
  // runs), and the consumer view must outlive an early boundary (buffered drain).
  const maybeCleanup = () => {
    if (!(consumerSettled && boundary.isReached)) return;
    gate.dispose();
    offActivity();
    offHook();
    offStatus();
  };
  const boundary = new TurnBoundary(maybeCleanup, options.drainMs);
  const failTurn = rejectTurn(gate, boundary);
  // The gate's SUCCESSFUL settle means the transcript drained — the real boundary. Its rejection
  // (a consumer failure) does NOT reach it here; a post-failure `ready`/terminal does.
  gate.done().then(
    () => boundary.reach(),
    () => undefined,
  );
  // A rejection with no boundary hook (Codex) arrives on activity; only the adapter's OWN error
  // payload is evidence, and it obeys the same turn binding as content (C-API-57).
  const readFailure = options.readFailureEvidence ?? noFailureEvidence;
  const offActivity = session.on("activity", (event) => {
    const evidence = activityFailure(readFailure, event, turnId);
    if (evidence) failTurn(evidence);
    const simple = toTurnEvent(event);
    if (simple || (event.kind === "user_message" && event.text === prompt)) acceptance.accept();
    if (simple) {
      started = true;
      turnId ??= event.turnId; // bind on the FIRST tagged event, not merely the first event
    }
    if (simple && (event.turnId === undefined || event.turnId === turnId)) {
      // Queue the event FIRST, then feed the oracle: observeText can end() the turn, and
      // push() drops events once ended — so the text that COMPLETES the turn is enqueued
      // before the completion check runs.
      gate.push(simple);
      if (simple.type === "text") gate.observeText(simple.text);
    }
    // Non-content transcript events hold the quiet window open too (C-API-57).
    if (event.source === "transcript" && !simple) gate.observeTurnSignal();
    if (boundary.draining) boundary.armDrain(); // trailing post-failure flush re-arms the drain
  });
  const readBoundarySignal = options.readBoundarySignal ?? defaultBoundarySignal;
  const offHook = session.on("hook", (event) => {
    // The adapter NORMALIZES its raw hook into the completeness signal (`undefined` for any
    // non-boundary hook, which the gate ignores so a late `Notification` cannot wipe an
    // installed oracle). The core reads only that — never raw hook fields — and uses it as a
    // completeness ORACLE only, never displayed (C-CLAUDE-15) — but failure evidence on the
    // same signal IS surfaced, as the `turn_failed` reason (C-API-57).
    if (defaultAcceptanceSignal(event, prompt)) acceptance.accept();
    const signal = readBoundarySignal(event);
    // A rejection that DOES reach a boundary hook (Claude's `StopFailure`) rides the signal.
    // Fail BEFORE the gate gets its expected text, so the turn ends as the failure it is.
    const evidence = signalFailure(signal);
    if (evidence) failTurn(evidence);
    gate.expectText(boundaryExpectation(signal));
  });
  const offStatus = session.on("status", ({ status }) => {
    if (status === "running") {
      started = true;
      acceptance.running();
    }
    if (terminalStatuses.has(status)) {
      acceptance.dispose();
      gate.end();
      return boundary.reach(); // agent is gone — the real boundary, regardless of consumer state
    }
    if (status === "ready" && started) {
      sawReady = true;
      if (acceptance.ready()) gate.observeReady();
      boundary.armDrain(); // failure path: agent reached ready → drain then release the slot
    }
  });

  // Drive the consumer lifecycle EAGERLY and independently of iteration: submit, then wait for
  // the gate to settle. Always resolves — the turn error reaches the consumer via `events`.
  const completion = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // A turn BEGINS on submission (PRD §5.8), so the opt-in ceiling is armed only AFTER
      // `sendMessage` resolves — never rejecting a prompt still queued behind readiness.
      await send(); // listeners attached — no early event lost
    } catch (error) {
      // The SUBMISSION failed → no agent turn is in flight and no status transition is coming:
      // fail the consumer with the typed error AND reach the boundary at once (else the
      // serializer waits forever). A terminal-status race is a benign idempotent no-op; otherwise
      // a submit-on-a-dead-session `session_not_running` propagates to the consumer (C-API-25).
      gate.fail(toError(error));
      boundary.reach();
      consumerSettled = true;
      maybeCleanup();
      return;
    }
    timer = armTurnTimeout(options.timeoutMs, (error) => gate.fail(error));
    try {
      await gate.done(); // resolves on genuine settle (→ boundary); rejects on consumer failure
    } catch {
      // Consumer failure after submission: the agent turn ran and may not be done, so the boundary
      // waits for a real `ready`/terminal (not a quiet window). If `ready` was ALREADY seen (a
      // catch-up failure — agent idle, transcript stalled), arm the drain now; no `ready` re-fires.
      boundary.markConsumerFailed();
      if (sawReady) boundary.armDrain();
    } finally {
      if (timer) clearTimeout(timer);
      acceptance.dispose();
      consumerSettled = true;
      maybeCleanup();
    }
  })();

  return { events: gate.drain(), completion, boundary: boundary.promise };
}
