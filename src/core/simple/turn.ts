/**
 * One ergonomic turn: submit a prompt and stream its simplified content events until the
 * transcript has caught up to the completed turn (PRD §5.8, C-API-48/49).
 *
 * The turn boundary is a COMPLETENESS ORACLE, not a timer. A turn's assistant text is
 * transcript-sourced (C-CLAUDE-15) and the transcript is written ASYNCHRONOUSLY, arriving
 * shortly AFTER the `ready` status. But the turn-boundary `Stop` hook carries
 * `last_assistant_message` — the final assistant text of the just-completed turn. We use
 * that ONLY as a completeness signal (never as displayed text — it can be ghost text): the
 * turn ends once the transcript-collected assistant text CONTAINS it. When there is no such
 * signal (a pure-tool turn, an empty/StopFailure payload, or a payload that never appears)
 * the turn ends after a bounded quiet window with no new content.
 *
 * Timeouts: a turn may legitimately run for HOURS (running a test suite, polling a PR), so
 * there is NO whole-turn timeout by default — a still-live turn is never failed by a clock;
 * a dead session ends it via terminal status, and callers may pass an opt-in `timeoutMs`.
 * The tight cap is `catchUpMs` (default 10s), armed ONLY once `ready` fires: the agent is
 * done, so the transcript flush should be near-instant — if it stalls past `catchUpMs`,
 * something broke and the turn rejects with `wait_timeout` rather than leave the caller
 * hanging. A terminal status always ends the turn at once.
 */

import type { ElwoodAgentSession, ElwoodCommonEventMap } from "../agent-session.ts";
import { elwoodError } from "../errors.ts";
import { terminalStatuses } from "../status-categories.ts";
import { type TurnEvent, toTurnEvent } from "./events.ts";
import { TurnGate } from "./turn-gate.ts";

/** The turn-boundary `hook` fields the completeness oracle reads (both adapters emit them). */
type TurnBoundaryHook = {
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
};

export async function* streamTurn(
  session: TurnSession,
  prompt: string,
  options: StreamTurnOptions = {},
): AsyncGenerator<TurnEvent> {
  const gate = new TurnGate(
    options.fallbackQuietMs ?? FALLBACK_QUIET_MS,
    options.catchUpMs ?? CATCH_UP_MS,
  );
  let turnId: string | undefined;
  let bound = false;
  let started = false; // the turn only ends on a settle once it has demonstrably started
  const offActivity = session.on("activity", (event) => {
    const simple = toTurnEvent(event);
    if (!bound && simple) {
      bound = true;
      started = true;
      turnId = event.turnId;
    }
    if (simple && (event.turnId === undefined || event.turnId === turnId)) {
      // Queue the event FIRST, then feed the oracle: observeText can end() the turn, and
      // push() drops events once ended — so the text that COMPLETES the turn must be
      // enqueued before the completion check runs.
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
  // Opt-in whole-turn ceiling only (default: none — a live turn is never failed by a clock).
  const timer =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(
          () => gate.fail(elwoodError("wait_timeout", "turn timed out")),
          options.timeoutMs,
        );
  try {
    await session.sendMessage(prompt); // submit AFTER listeners attach, so no early event is lost
    yield* gate.drain();
  } finally {
    if (timer) clearTimeout(timer);
    gate.dispose();
    offActivity();
    offHook();
    offStatus();
  }
}
