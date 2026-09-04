/** Adapter-neutral recurring-loop state machine (PRD §5.9, C-LOOP-04 through C-LOOP-20). */
import { runContained } from "../contained.ts";
import { elwoodError } from "../errors.ts";
import { MAX_ACTIVE_LOOPS } from "./constants.ts";
import { LoopDelivery } from "./scheduler-delivery.ts";
import {
  createLoopDefinition,
  type LoopActivityOrigin,
  type LoopDefinition,
  type LoopRuntimeEntry,
  type LoopSchedulerOptions,
  LoopSchedulerState,
  loopFailureEvent,
  persistLoopDefinitions,
  redactLoop,
  snapshotLoop,
} from "./scheduler-state.ts";
import { LoopTimerBank, LoopTiming } from "./timers.ts";
import type { ElwoodLoopEvent, ElwoodLoopSnapshot } from "./types.ts";
import { validateLoopRequest } from "./validate.ts";

export class LoopScheduler {
  private readonly options: LoopSchedulerOptions;
  private readonly state: LoopSchedulerState;
  private readonly timers: LoopTimerBank;
  private readonly timing: LoopTiming;
  private readonly delivery: LoopDelivery;
  private live = false;
  constructor(options: LoopSchedulerOptions) {
    this.options = options;
    this.state = new LoopSchedulerState(options.definitions ?? []);
    this.timers = new LoopTimerBank(options.schedule);
    this.timing = new LoopTiming(this.timers, {
      state: this.state,
      now: options.now,
      live: () => this.live,
      fail: (entry) => this.failed(entry, "scheduling"),
      expire: (loopId) => this.expire(loopId),
      pump: () => this.delivery.pump(this.live),
    });
    this.delivery = new LoopDelivery({
      state: this.state,
      now: options.now,
      submit: options.submit,
      armDue: (entry, anchor) => this.timing.armDue(entry, anchor),
      expire: (loopId) => this.timing.expireSafely(loopId),
      fail: (entry) => this.failed(entry, "submission"),
      emit: (event) => this.emit(event),
    });
  }
  start(): void {
    if (this.live) return;
    this.pruneExpired(false);
    this.live = true;
    for (const entry of this.state.entries()) this.timing.armExpiry(entry);
  }
  ready(): void {
    if (!this.live) this.start();
    const origin = this.delivery.markReady();
    for (const entry of this.state.entries()) {
      if (
        entry.state === "waiting" ||
        (entry.definition.id === origin && entry.definition.mode === "idle")
      ) {
        this.timing.armDue(entry, this.options.now());
      } else if (entry.state === "submitted") {
        entry.state = "scheduled";
      }
    }
    this.delivery.pump(this.live);
  }
  running(): void {
    this.delivery.markRunning();
  }
  activity(origin: LoopActivityOrigin): void {
    if (origin !== "caller") return;
    const remainReady = this.delivery.readyNow;
    this.delivery.markRunning();
    for (const entry of this.state.entries()) {
      if (entry.definition.mode !== "idle") continue;
      this.timers.cancelDue(entry.definition.id);
      entry.state = "waiting";
      entry.nextDueAt = undefined;
      entry.dueAt = undefined;
    }
    this.delivery.cancelIf((id) => this.state.get(id)?.definition.mode === "idle");
    if (remainReady) this.ready();
  }
  create(rawRequest: unknown): ElwoodLoopSnapshot {
    if (!this.live) throw elwoodError("session_not_running", "Session is not running.");
    this.pruneExpired(true);
    const request = validateLoopRequest(rawRequest);
    if (this.state.entries().length >= MAX_ACTIVE_LOOPS) {
      throw elwoodError("loop_limit_reached", "Loop limit reached.");
    }
    const definition = createLoopDefinition(request, this.options.createId(), this.options.now());
    const definitions = [...this.state.definitions(), definition];
    this.persist(definitions, [definition.id], definition.id);
    this.state.commit(definitions);
    const entry = this.state.get(definition.id) as LoopRuntimeEntry;
    this.timing.armExpiry(entry);
    if (definition.mode === "fixed" || this.delivery.readyNow) {
      this.timing.armDue(entry, definition.createdAt);
    }
    this.emit({
      kind: "created",
      loopId: definition.id,
      at: definition.createdAt,
      snapshot: redactLoop(entry),
    });
    return snapshotLoop(entry);
  }
  list(): readonly ElwoodLoopSnapshot[] {
    this.pruneExpired(this.live);
    return this.state.snapshots();
  }
  cancel(loopId: string, reason: "caller" | "kill" | "teardown" = "caller"): void {
    this.pruneExpired(this.live);
    if (!this.state.get(loopId))
      throw elwoodError("loop_not_found", "Loop was not found.", { loopId });
    const definitions = this.state.without(loopId);
    this.persist(definitions, [loopId], loopId);
    this.remove(loopId, definitions);
    this.emit({ kind: "cancelled", loopId, at: this.options.now(), reason });
    this.delivery.pump(this.live);
  }
  clear(reason: "kill" | "teardown"): void {
    const [definitions, wasLive] = [this.state.definitions(), this.live] as const;
    try {
      if (definitions.length > 0)
        this.persist(
          [],
          definitions.map(({ id }) => id),
        );
    } catch (error) {
      this.pause();
      throw error;
    }
    this.pause();
    this.state.commit([]);
    for (const { id } of definitions)
      this.emit({ kind: "cancelled", loopId: id, at: this.options.now(), reason }, wasLive);
  }
  pause(): void {
    this.live = false;
    this.timers.clear();
    this.delivery.pause();
    for (const entry of this.state.entries()) {
      entry.state = "waiting";
      entry.nextDueAt = undefined;
      entry.dueAt = undefined;
    }
  }
  private expire(loopId: string): void {
    if (!this.state.get(loopId)) return;
    const definitions = this.state.without(loopId);
    this.persist(definitions, [loopId], loopId);
    this.remove(loopId, definitions);
    if (this.live) this.emit({ kind: "expired", loopId, at: this.options.now() });
    this.delivery.pump(this.live);
  }
  private pruneExpired(emit: boolean): void {
    const now = this.options.now();
    const expired = this.state.expired(now);
    if (expired.length === 0) return;
    this.persist(
      this.state.unexpired(now),
      expired.map(({ id }) => id),
    );
    for (const { id } of expired) {
      this.remove(id);
      if (emit) this.emit({ kind: "expired", loopId: id, at: now });
    }
  }
  private remove(loopId: string, definitions = this.state.without(loopId)): void {
    this.timers.cancelLoop(loopId);
    this.state.commit(definitions);
    this.delivery.cancel(loopId);
  }
  private persist(
    definitions: readonly LoopDefinition[],
    affectedLoopIds: readonly string[],
    errorLoopId?: string,
  ): void {
    persistLoopDefinitions(
      this.state,
      this.options,
      definitions,
      { affectedLoopIds, ...(errorLoopId ? { errorLoopId } : {}) },
      (event) => this.emit(event),
    );
  }
  private failed(entry: LoopRuntimeEntry, phase: "scheduling" | "submission"): void {
    this.emit(loopFailureEvent(entry.definition.id, this.options.now(), phase, entry));
  }
  private emit(event: ElwoodLoopEvent, wasLive = this.live): void {
    if (!wasLive) return;
    runContained(() => this.options.emit(event));
  }
}
