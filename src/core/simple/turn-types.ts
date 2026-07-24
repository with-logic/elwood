/**
 * Types and conformance probes for one ergonomic turn (PRD §5.8, C-API-48/53). Separated from
 * the `runTurn` runner (turn.ts) so both stay under the file-size cap. Defines the loose
 * boundary-hook shape the oracle reads, the compile-time drift guard adapters assert against,
 * the narrow turn-capable session surface, and the turn's options and result shapes.
 */

import type { ElwoodAgentSession, ElwoodCommonEventMap } from "../agent-session.ts";
import type { TurnEvent } from "./events.ts";

/**
 * The MINIMAL turn-boundary `hook` fields the completeness oracle reads. Deliberately
 * adapter-neutral (core must not depend on adapter hook types) — the `hook` listener accepts
 * this loose shape, but each adapter asserts CONFORMANCE against `TurnBoundaryContract` below
 * so a contract change (renamed/removed `last_assistant_message`) fails to compile.
 */
export type TurnBoundaryHook = {
  readonly hook_event_name?: string;
  readonly last_assistant_message?: string | null;
};

/**
 * The turn-boundary fields the oracle DEPENDS ON. `TurnBoundaryHook` is deliberately loose (a
 * missing/`null` value just means "no oracle" → quiet settle), but a `Stop` payload that
 * RENAMED or DROPPED `last_assistant_message` would silently disable the oracle, so
 * `AssertStopBoundary` enforces each adapter's real `Stop` event still DECLARES these keys.
 */
export type TurnBoundaryContract = {
  readonly hook_event_name: string | undefined;
  readonly last_assistant_message: string | null | undefined;
};

/**
 * Compile-time conformance probe: `true` only if `T` declares every `TurnBoundaryContract` key
 * (`keyof extends keyof T` — a renamed/dropped key → `never`) with an assignable value
 * (`Required<T>` reads the type ignoring optionality, so an optional key passes but a type
 * change → `never`). Either drift makes the adapter assertion fail to compile.
 *
 * This is the EFFECTIVE turn-capability guard. A `SessionBase<S extends TurnSession>` bound
 * would NOT enforce hook-capability: TypeScript method-parameter bivariance lets a session whose
 * `on` lacks the `hook` overload structurally satisfy `TurnSession`, so a generic bound accepts
 * a hook-less session and silently loses oracle semantics. Instead, each concrete adapter
 * asserts `AssertStopBoundary<HookEventFor<"Stop">>` on its REAL `Stop` payload, catching the
 * exact drift that matters. Any new `SessionBase` subclass MUST add the same assertion.
 */
export type AssertStopBoundary<T> = keyof TurnBoundaryContract extends keyof T
  ? Pick<Required<T>, keyof TurnBoundaryContract & keyof T> extends TurnBoundaryContract
    ? true
    : never
  : never;

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

export type StreamTurnOptions = {
  /** Optional whole-turn ceiling; default NONE — a live turn may run for hours. */
  readonly timeoutMs?: number;
  /** Cap on transcript catch-up after `ready` (default 10s); a stalled flush → `wait_timeout`. */
  readonly catchUpMs?: number;
  /** Quiet-window for a no-oracle turn to settle after `ready` (default 750ms). */
  readonly fallbackQuietMs?: number;
  /** Cap on unconsumed buffered events before failing (default 100000); internal/tests. */
  readonly maxPendingEvents?: number;
  /** Cap on unconsumed buffered bytes before failing (default 64 MiB); internal/tests. */
  readonly maxPendingBytes?: number;
};

/** A running turn: `events`/`completion` are the consumer view; `boundary` gates the serializer. */
export type RunningTurn = {
  /** The turn's simplified content events; abandoning this does NOT stop the turn. */
  readonly events: AsyncGenerator<TurnEvent>;
  /**
   * Always-resolving GATE-settlement signal. The runner drives it EAGERLY — it resolves when the
   * gate settles (success or a consumer-facing failure) whether or not `events` was ever
   * consumed; the turn's error, if any, is carried by `events`, never thrown here. It is NOT the
   * serializer boundary (a timeout/backlog failure settles this while the agent still runs) — use
   * `boundary` for that. Named `completion` because it marks the consumer's view of the turn done.
   */
  readonly completion: Promise<void>;
  /**
   * The serializer's slot-release signal: resolves only when the AGENT genuinely settles. On the
   * SUCCESS path that is the gate's real end (the transcript drained); on a consumer FAILURE it is
   * a real `ready` (a busy agent is `running`, not ready) or a terminal status, then a short drain.
   * It does NOT resolve on the consumer failure itself, so the next turn never binds this turn's
   * still-arriving activity.
   */
  readonly boundary: Promise<void>;
};
