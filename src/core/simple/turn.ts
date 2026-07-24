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
 * timeout by default; callers may pass an opt-in `timeoutMs`. The tight cap is `catchUpMs`
 * (default 10s), armed only ONCE `ready` fires — the flush should be near-instant, so a
 * longer stall rejects with `wait_timeout`. A terminal status ends the turn at once.
 */

import type { ElwoodAgentSession, ElwoodCommonEventMap } from "../agent-session.ts";
import { elwoodError, toError } from "../errors.ts";
import { terminalStatuses } from "../status-categories.ts";
import { type TurnEvent, toTurnEvent } from "./events.ts";
import { TurnGate } from "./turn-gate.ts";

/**
 * The MINIMAL turn-boundary `hook` fields the completeness oracle reads. Deliberately
 * adapter-neutral (core must not depend on adapter hook types) — each adapter asserts at
 * compile time that its real `Stop` hook payload is assignable to this (see
 * `assertStopHookShape` in the adapter `simple.ts`), so a contract drift is caught.
 */
export type TurnBoundaryHook = {
  readonly hook_event_name?: string;
  readonly last_assistant_message?: string | null;
};

/**
 * The narrow session surface a turn drives: the common events plus the adapter `hook`
 * event (whose `Stop` payload's `last_assistant_message` is the completeness oracle). Any
 * Elwood session satisfies this — both `ElwoodEventMap` and `CodexEventMap` carry `hook`.
 */
export type TurnSession = Pick<ElwoodAgentSession, "status" | "sendMessage"> & {
  on<E extends keyof ElwoodCommonEventMap>(
    event: E,
    handler: (event: ElwoodCommonEventMap[E]) => void,
  ): () => void;
  on(event: "hook", handler: (event: TurnBoundaryHook) => void): () => void;
};

/** Quiet window (ms) after `ready` for a no-oracle turn to settle once content stops. */
const FALLBACK_QUIET_MS = 750;
/** Cap (ms) on the POST-`ready` transcript catch-up: a stalled flush bails, not hangs. */
const CATCH_UP_MS = 10_000;

export type StreamTurnOptions = {
  /** Optional whole-turn ceiling; default NONE — a live turn may run for hours. */
  readonly timeoutMs?: number;
  /** Cap on transcript catch-up after `ready` (default 10s); a stalled flush → `wait_timeout`. */
  readonly catchUpMs?: number;
  /** Quiet-window for a no-oracle turn to settle after `ready` (default 750ms). */
  readonly fallbackQuietMs?: number;
  /** Cap on unconsumed buffered events before failing (default 100000); internal/tests. */
  readonly maxPendingEvents?: number;
};

/** A running turn: `events` is the consumer view; `completion` resolves at the REAL boundary. */
export type RunningTurn = {
  /** The turn's simplified content events; abandoning this does NOT stop the turn. */
  readonly events: AsyncGenerator<TurnEvent>;
  /** Resolves when the agent turn reaches its real boundary; rejects on failure/timeout. */
  readonly completion: Promise<void>;
};

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
  const offStatus = session.on("status", ({ status }) => {
    if (status === "running") started = true;
    if (terminalStatuses.has(status)) return gate.end();
    if (status === "ready" && started) gate.settle();
  });

  const cleanup = () => {
    gate.dispose();
    offActivity();
    offHook();
    offStatus();
  };

  // Drive the turn's lifecycle EAGERLY and independently of the consumer: submit, then wait
  // for the gate to reach the real boundary. Runs to completion even if the consumer breaks.
  const completion = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const send = session.sendMessage(prompt); // listeners attached — no early event lost
      // Arm the opt-in whole-turn ceiling now; the whole turn (including any queue/readiness
      // wait) is what the caller opted to bound.
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(
          () => gate.fail(elwoodError("wait_timeout", "turn timed out")),
          options.timeoutMs,
        );
      }
      await send;
      await gate.done(); // rejects on fail/timeout — the error is already recorded for `drain`
    } catch (error) {
      // A submit failure on a terminal session ends the turn cleanly (buffered events keep,
      // iterator ends without error); any other submit error becomes the turn's failure. The
      // error reaches the consumer via `gate.drain()`, so `completion` only SIGNALS that the
      // turn settled (it always resolves — never an unhandled rejection for a caller that
      // ignores it, e.g. an abandoning consumer whose slot the serializer still awaits).
      if ((error as { code?: string })?.code === "session_not_running") gate.end();
      else gate.fail(toError(error));
    } finally {
      if (timer) clearTimeout(timer);
      cleanup();
    }
  })();

  return { events: gate.drain(), completion };
}
