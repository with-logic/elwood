/**
 * Collect one ergonomic turn through native completion and transcript drain (PRD §5.8).
 * Consumer failure settles events but retains the serializer boundary until actual completion
 * or terminal status. Codex acceptance and Stop identity come from private adapter evidence;
 * public running/ready alone cannot bind or finish its turn. Untagged adapters retain the
 * serialized passive oracle. The Stop oracle checks completeness; it never supplies output.
 * Whole-turn deadlines start after physical submission; catch-up deadlines start after idle.
 */

import { toError } from "../errors.ts";
import { cancellableSubmission } from "../input/submission-cancel.ts";
import { terminalStatuses } from "../status-categories.ts";
import { boundaryExpectation } from "./boundary-signal.ts";
import { toTurnEvent } from "./events.ts";
import { withSubmissionAttempt } from "./submission-context.ts";
import { armTurnTimeout, FALLBACK_QUIET_MS, gateForTurn } from "./turn/defaults.ts";
import { TurnAcceptance } from "./turn-acceptance.ts";
import { TurnBoundary } from "./turn-boundary.ts";
import { TurnIdentity } from "./turn-identity.ts";
import {
  defaultAcceptanceSignal,
  defaultBoundarySignal,
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

/** Attach before owned submission; retain the native boundary after consumer failure. */
export function runTurn(
  session: TurnSession,
  prompt: string,
  options: StreamTurnOptions = {},
): RunningTurn {
  const gate = gateForTurn(options);
  const sendOptions = options.images === undefined ? undefined : { images: options.images };
  const identity = options.readNativeTurn && new TurnIdentity(session, options.readNativeTurn);
  let submitted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onSubmitted = () => {
    if (submitted) return;
    submitted = true;
    timer = armTurnTimeout(options.timeoutMs, (error) => gate.fail(error));
  };
  const acceptance = new TurnAcceptance(options.fallbackQuietMs ?? FALLBACK_QUIET_MS, {
    write: (signal) => {
      const send = () =>
        session.sendMessage(prompt, cancellableSubmission(sendOptions, signal, onSubmitted));
      return identity ? withSubmissionAttempt(session, identity, send) : send();
    },
    acceptReady: () => {
      if (!identity) gate.observeReady();
    },
    fail: (error) => gate.fail(toError(error)),
  });
  let turnId: string | undefined;
  let started = false;
  let sawReady = false; // a `ready` after the turn started was observed (agent turn is idle/done)
  let consumerSettled = false;

  // Listeners are removed only once BOTH the consumer has settled AND the real boundary is
  // reached: the boundary observer must outlive a consumer failure (a timed-out turn whose agent
  // is still running), and the consumer view must outlive an early boundary (buffered drain).
  const maybeCleanup = () => {
    if (!(consumerSettled && boundary.isReached)) return;
    gate.dispose();
    offActivity();
    offHook();
    offStatus();
    offNativeBoundary();
  };
  const boundary = new TurnBoundary(maybeCleanup, options.drainMs, () => acceptance.quiesce());
  // The gate's SUCCESSFUL settle means the transcript drained — the real boundary. Its rejection
  // (a consumer failure) does NOT reach it here; a post-failure `ready`/terminal does.
  acceptance.disarmOnSettle(gate.done(), () => boundary.reach());

  const offActivity = session.on("activity", (event) => {
    const simple = toTurnEvent(event);
    if (identity && !identity.acceptsContent(event.turnId)) return;
    if (simple || (!identity && event.kind === "user_message" && event.text === prompt))
      acceptance.accept();
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
    if (boundary.draining) boundary.armDrain(); // trailing post-failure flush re-arms the drain
  });
  const nativeIdle = () => {
    if (!identity?.ready()) return;
    sawReady = true;
    gate.observeReady();
    boundary.armDrain();
  };
  const offNativeBoundary =
    identity?.observeBoundary((signal) => {
      gate.expectText(boundaryExpectation(signal));
      nativeIdle();
    }, nativeIdle) ?? (() => undefined);
  const readBoundarySignal = options.readBoundarySignal ?? defaultBoundarySignal;
  const offHook = session.on("hook", (event) => {
    // The adapter NORMALIZES its raw hook into the completeness signal (`undefined` for any
    // non-boundary hook, which the gate ignores so a late `Notification` cannot wipe an
    // installed oracle). The core reads only that — never raw hook fields — and uses it as a
    // completeness ORACLE only, never displayed (C-CLAUDE-15).
    if (identity) {
      if (identity.observe(event)) acceptance.accept();
      return; // Public Stop precedes its callback outcome; only private confirmation owns the oracle.
    }
    if (defaultAcceptanceSignal(event, prompt)) acceptance.accept();
    gate.expectText(boundaryExpectation(readBoundarySignal(event)));
  });
  const offStatus = session.on("status", ({ status }) => {
    if (status === "running") {
      started = true;
      sawReady = false;
      boundary.cancelDrain();
      acceptance.running();
    }
    if (terminalStatuses.has(status)) {
      acceptance.dispose();
      gate.end();
      return boundary.reach(); // agent is gone — the real boundary, regardless of consumer state
    }
    if (status === "ready" && started) {
      const accepted = acceptance.ready();
      if (identity && !identity.ready()) return;
      sawReady = true;
      if (accepted) gate.observeReady();
      boundary.armDrain(); // failure path: agent reached ready → drain then release the slot
    }
  });

  // Drive the consumer lifecycle EAGERLY and independently of iteration: submit, then wait for
  // the gate to settle. Always resolves — the turn error reaches the consumer via `events`.
  const completion = (async () => {
    try {
      // Native submission arms its ceiling at physical Enter; this await also retains
      // ownership through fresh-empty confirmation or cancellation cleanup.
      await acceptance.submit(); // listeners attached — no early event lost
      onSubmitted(); // fallback for custom TurnSession implementations without private metadata
    } catch (error) {
      gate.fail(toError(error));
      if (!(submitted || identity?.attempted)) {
        // No physical Enter: no native turn or future status needs draining.
        boundary.reach();
        consumerSettled = true;
        maybeCleanup();
        return;
      }
    }
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
      consumerSettled = true;
      maybeCleanup();
    }
  })();

  return { events: gate.drain(), completion, boundary: boundary.promise };
}
