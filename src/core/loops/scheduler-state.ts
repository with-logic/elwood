/**
 * Adapter-neutral recurring-loop scheduler state and injected dependency types.
 * Implements PRD §5.9 and C-LOOP-05 through C-LOOP-20.
 */

import { elwoodError } from "../errors.ts";
import { IDLE_LOOP_INTERVAL_MS, LOOP_EXPIRATION_MS } from "./constants.ts";
import { deriveLoopJitterMs } from "./jitter.ts";
import type { LoopTimerScheduler } from "./timers.ts";
import type {
  ElwoodLoopEvent,
  ElwoodLoopRequest,
  ElwoodLoopSnapshot,
  ElwoodLoopState,
} from "./types.ts";

export type LoopDefinition =
  | {
      readonly id: string;
      readonly message: string;
      readonly mode: "fixed";
      readonly intervalMs: number;
      readonly jitterMs: number;
      readonly createdAt: number;
      readonly expiresAt: number;
    }
  | {
      readonly id: string;
      readonly message: string;
      readonly mode: "idle";
      readonly jitterMs: number;
      readonly createdAt: number;
      readonly expiresAt: number;
    };

export type LoopRuntimeEntry = {
  readonly definition: LoopDefinition;
  state: ElwoodLoopState;
  nextDueAt: number | undefined;
  dueAt: number | undefined;
};

export type LoopSubmission = (
  message: string,
  loopId: string,
  signal: AbortSignal,
) => Promise<void>;

export type LoopSchedulerOptions = {
  readonly definitions?: readonly LoopDefinition[];
  readonly now: () => number;
  readonly schedule: LoopTimerScheduler;
  readonly createId: () => string;
  readonly persist: (definitions: readonly LoopDefinition[]) => void;
  readonly submit: LoopSubmission;
  readonly emit: (event: ElwoodLoopEvent) => void;
};

export type LoopActivityOrigin = "caller" | "loop" | "warning" | "administration";

export class LoopSchedulerState {
  private entriesById = new Map<string, LoopRuntimeEntry>();

  constructor(definitions: readonly LoopDefinition[]) {
    this.commit(definitions);
  }

  get(id: string): LoopRuntimeEntry | undefined {
    return this.entriesById.get(id);
  }

  entries(): readonly LoopRuntimeEntry[] {
    return [...this.entriesById.values()];
  }

  definitions(): readonly LoopDefinition[] {
    return this.entries().map(({ definition }) => definition);
  }

  without(id: string): readonly LoopDefinition[] {
    return this.definitions().filter((definition) => definition.id !== id);
  }

  expired(now: number): readonly LoopDefinition[] {
    return this.definitions().filter(({ expiresAt }) => expiresAt <= now);
  }

  unexpired(now: number): readonly LoopDefinition[] {
    return this.definitions().filter(({ expiresAt }) => expiresAt > now);
  }

  commit(definitions: readonly LoopDefinition[]): void {
    const prior = this.entriesById;
    this.entriesById = new Map(
      definitions.map((definition) => {
        const existing = prior.get(definition.id);
        return [
          definition.id,
          existing
            ? { ...existing, definition }
            : { definition, state: "waiting", nextDueAt: undefined, dueAt: undefined },
        ];
      }),
    );
  }

  snapshots(): readonly ElwoodLoopSnapshot[] {
    return this.entries()
      .map(snapshotLoop)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  due(): readonly LoopRuntimeEntry[] {
    return this.entries()
      .filter((entry) => entry.state === "due")
      .sort(
        (a, b) =>
          (a.dueAt as number) - (b.dueAt as number) ||
          a.definition.id.localeCompare(b.definition.id),
      );
  }
}

export function snapshotLoop(entry: LoopRuntimeEntry): ElwoodLoopSnapshot {
  const { definition, state } = entry;
  return {
    ...definition,
    state,
    ...(state === "scheduled" && entry.nextDueAt !== undefined
      ? { nextDueAt: entry.nextDueAt }
      : {}),
  };
}

export function redactLoop(entry: LoopRuntimeEntry): Omit<ElwoodLoopSnapshot, "message"> {
  const { message: _message, ...snapshot } = snapshotLoop(entry);
  return snapshot;
}
export function createLoopDefinition(
  request: ElwoodLoopRequest,
  id: string,
  createdAt: number,
): LoopDefinition {
  const cadence = request.mode === "fixed" ? request.intervalMs : IDLE_LOOP_INTERVAL_MS;
  return {
    ...request,
    id,
    jitterMs: deriveLoopJitterMs(id, cadence),
    createdAt,
    expiresAt: createdAt + LOOP_EXPIRATION_MS,
  };
}
export function loopFailureEvent(
  loopId: string,
  at: number,
  phase: "persistence" | "scheduling" | "submission",
  entry?: LoopRuntimeEntry,
): Extract<ElwoodLoopEvent, { readonly kind: "failed" }> {
  const code = phase === "persistence" ? "loop_persistence_failed" : "loop_submission_failed";
  return {
    kind: "failed",
    loopId,
    at,
    phase,
    code,
    message:
      code === "loop_persistence_failed" ? "Loop persistence failed." : "Loop submission failed.",
    ...(entry ? { snapshot: redactLoop(entry) } : {}),
  };
}
export function persistLoopDefinitions(
  state: LoopSchedulerState,
  options: Pick<LoopSchedulerOptions, "now" | "persist">,
  definitions: readonly LoopDefinition[],
  loopId: string | undefined,
  emit: (event: ElwoodLoopEvent) => void,
): void {
  try {
    options.persist(definitions);
  } catch {
    const entries = loopId ? [state.get(loopId)].filter(Boolean) : state.entries();
    if (loopId && entries.length === 0)
      emit(loopFailureEvent(loopId, options.now(), "persistence"));
    for (const entry of entries) {
      emit(
        loopFailureEvent(
          (entry as LoopRuntimeEntry).definition.id,
          options.now(),
          "persistence",
          entry as LoopRuntimeEntry,
        ),
      );
    }
    throw elwoodError(
      "loop_persistence_failed",
      "Loop persistence failed.",
      loopId ? { loopId } : {},
    );
  }
}
