import type { BoundarySignal } from "./boundary-signal.ts";
/**
 * Types and conformance probes for one ergonomic turn (PRD §5.8, C-API-48/53). Separated from
 * the `runTurn` runner (turn.ts) so both stay under the file-size cap. Defines the loose
 * boundary-hook shape the oracle reads, the compile-time drift guard adapters assert against,
 * the narrow turn-capable session surface, and the turn's options and result shapes.
 */

import type { ElwoodAgentSession, ElwoodCommonEventMap } from "../agent-session.ts";
import type { ImageInput } from "../images/types.ts";
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
  readonly prompt?: string;
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
 * NORMALIZES a raw adapter `hook` event into the core's completeness signal. The two outcomes
 * are DISTINCT: `undefined` means "not a turn boundary" (the runner ignores the event — an
 * installed oracle stays installed), while a `BoundarySignal` means "a turn boundary whose
 * expected final assistant text is this" — an EMPTY string is a boundary that carries no text
 * (`null`/absent `last_assistant_message`, e.g. `StopFailure`) and clears the oracle →
 * quiet-window settle.
 * This is the ONE seam where adapter hook shape meets the adapter-neutral runner: `runTurn`
 * consumes only this normalized signal, never raw `hook_event_name`/`last_assistant_message`, so
 * the core is not coupled to adapter hook fields. Each `SessionBase` subclass supplies its own
 * reader (a compile-time REQUIREMENT), so a new adapter cannot wire up turns without one.
 */
export type { BoundarySignal, TurnFailure } from "./boundary-signal.ts";
export { boundaryFailure, boundaryText } from "./boundary-signal.ts";

export type BoundarySignalReader = (hookEvent: TurnBoundaryHook) => BoundarySignal | undefined;

/** Normalizes shared hook evidence into positive acceptance for one exact prompt. */
export type AcceptanceSignalReader = (hookEvent: TurnBoundaryHook, prompt: string) => boolean;

/**
 * The default reader: a `Stop` hook is the turn boundary and its `last_assistant_message` the
 * completeness signal (`""` when null/absent → no oracle); any other hook is not a boundary.
 */
export const defaultBoundarySignal: BoundarySignalReader = (event) =>
  event.hook_event_name === "Stop" ? (event.last_assistant_message ?? "") : undefined;

/** Shared Claude/Codex acceptance: the matching submit hook or any Stop boundary. */
export const defaultAcceptanceSignal: AcceptanceSignalReader = (event, prompt) =>
  event.hook_event_name === "Stop" ||
  (event.hook_event_name === "UserPromptSubmit" && event.prompt === prompt);

/**
 * Compile-time conformance probe: `true` only if `T` declares every `TurnBoundaryContract` key
 * (`keyof extends keyof T` — a renamed/dropped key → `never`) with an assignable value
 * (`Required<T>` reads the type ignoring optionality, so an optional key passes but a type
 * change → `never`). Either drift makes the adapter assertion fail to compile.
 *
 * One of two turn-capability guards. `SessionBase` requires each subclass to implement the
 * abstract `readBoundarySignal` (a hook→expected-text normalizer), so the runner never reads raw
 * adapter hook fields and a new adapter cannot wire turns WITHOUT a boundary reader. This
 * assertion is the complement: it pins the adapter's REAL `Stop` payload so `readBoundarySignal`'s
 * field access can't drift silently. (A `SessionBase<S extends TurnSession>` bound would NOT
 * enforce hook-capability — method-parameter bivariance lets a hook-less `on` satisfy the `hook`
 * overload — which is why the abstract method + this assertion, not a generic bound, are the guard.)
 */
export type AssertStopBoundary<T> = keyof TurnBoundaryContract extends keyof T
  ? Pick<Required<T>, keyof TurnBoundaryContract & keyof T> extends TurnBoundaryContract
    ? true
    : never
  : never;

/**
 * The narrow session surface a turn drives: the common events plus the adapter `hook`
 * event (whose `Stop` payload's `last_assistant_message` is the completeness oracle). Any
 * Elwood session satisfies this — both `ClaudeEventMap` and `CodexEventMap` carry `hook`.
 */
export type TurnSession = Pick<ElwoodAgentSession, "status" | "sendMessage"> & {
  on<E extends keyof ElwoodCommonEventMap>(
    event: E,
    handler: (event: ElwoodCommonEventMap[E]) => void,
  ): () => void;
  on(event: "hook", handler: (event: TurnBoundaryHook) => void): () => void;
};

/** Per-call PUBLIC turn options (the caller-facing subset of `StreamTurnOptions`). */
export type TurnOptions = {
  /** Opt-in whole-turn ceiling → `wait_timeout`. Default NONE — a turn may run for hours. */
  readonly timeoutMs?: number;
  /** Cap on transcript catch-up AFTER `ready` (default 10s); a stalled flush → `wait_timeout`. */
  readonly catchUpMs?: number;
  /** Readable images attached, in order, to this same user turn. */
  readonly images?: readonly ImageInput[];
};

export type StreamTurnOptions = {
  /** Optional whole-turn ceiling; default NONE — a live turn may run for hours. */
  readonly timeoutMs?: number;
  /** Cap on transcript catch-up after `ready` (default 10s); a stalled flush → `wait_timeout`. */
  readonly catchUpMs?: number;
  /** Readable images attached, in order, to this same user turn. */
  readonly images?: readonly ImageInput[];
  /** Quiet-window for a no-oracle turn to settle after `ready` (default 2000ms). */
  readonly fallbackQuietMs?: number;
  /** Cap on unconsumed buffered events before failing (default 100000); internal/tests. */
  readonly maxPendingEvents?: number;
  /** Cap on unconsumed buffered bytes before failing (default 64 MiB); internal/tests. */
  readonly maxPendingBytes?: number;
  /** Post-failure `ready` transcript-drain settle (default 750ms); internal/tests. */
  readonly drainMs?: number;
  /**
   * Normalizes an adapter `hook` event into the completeness signal (default:
   * `defaultBoundarySignal`, the `Stop` hook's `last_assistant_message`). `SessionBase` subclasses
   * pass their own so the runner never reads raw adapter hook fields.
   */
  readonly readBoundarySignal?: BoundarySignalReader;
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
   * still-arriving activity. Both paths also wait for cancelled replay writes, recovery
   * Enters, and attachment cleanup before releasing the slot and captured-image reservation.
   */
  readonly boundary: Promise<void>;
};
