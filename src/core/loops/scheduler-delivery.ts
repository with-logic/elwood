/**
 * Serialized due-loop selection and submission settlement for the loop scheduler.
 * Implements PRD §5.9 and C-LOOP-08/C-LOOP-09/C-LOOP-17.
 */

import { elwoodError } from "../errors.ts";
import {
  type LoopRuntimeEntry,
  type LoopSchedulerOptions,
  type LoopSchedulerState,
  redactLoop,
} from "./scheduler-state.ts";
import type { ElwoodLoopEvent } from "./types.ts";

type Candidate = { readonly id: string; readonly dueAt: number; readonly abort: AbortController };

type DeliveryOptions = Pick<LoopSchedulerOptions, "now" | "submit"> & {
  readonly state: LoopSchedulerState;
  readonly armDue: (entry: LoopRuntimeEntry, anchor: number) => void;
  readonly expire: (loopId: string) => void;
  readonly fail: (entry: LoopRuntimeEntry) => void;
  readonly emit: (event: ElwoodLoopEvent) => void;
};

export class LoopDelivery {
  private readonly options: DeliveryOptions;
  private candidate: Candidate | undefined;
  private activeOrigin: string | undefined;
  private readyState = false;

  constructor(options: DeliveryOptions) {
    this.options = options;
  }

  get readyNow(): boolean {
    return this.readyState;
  }

  markReady(): string | undefined {
    this.readyState = true;
    const origin = this.activeOrigin;
    this.activeOrigin = undefined;
    return origin;
  }

  markRunning(): void {
    this.readyState = false;
  }

  pump(live: boolean): void {
    if (!(live && this.readyState) || this.candidate) return;
    const entry = this.options.state.due()[0];
    if (!entry) return;
    if (entry.definition.expiresAt <= this.options.now()) {
      this.options.expire(entry.definition.id);
      return;
    }
    const candidate = {
      id: entry.definition.id,
      dueAt: entry.dueAt as number,
      abort: new AbortController(),
    };
    this.candidate = candidate;
    this.readyState = false;
    this.options.submit(entry.definition.message, candidate.id, candidate.abort.signal).then(
      () => this.submitted(candidate),
      () => this.rejected(candidate),
    );
  }

  /**
   * Aborts an in-flight write for `loopId`. `activeOrigin` is deliberately left alone: a
   * cancelled loop no longer exists for `ready()` to re-arm, and caller activity already
   * resets every idle loop to `waiting` (re-armed at the next `ready` regardless of origin).
   */
  cancel(loopId: string): void {
    if (this.candidate?.id !== loopId) return;
    const candidate = this.candidate;
    this.candidate = undefined;
    this.readyState = true;
    candidate.abort.abort(cancelledError(loopId));
  }

  cancelIf(predicate: (loopId: string) => boolean): void {
    if (this.candidate && predicate(this.candidate.id)) this.cancel(this.candidate.id);
  }

  pause(): void {
    this.readyState = false;
    this.candidate?.abort.abort(cancelledError(this.candidate.id));
    this.candidate = this.activeOrigin = undefined;
  }

  private submitted(candidate: Candidate): void {
    const entry = this.settled(candidate);
    if (!entry) return;
    if (entry.definition.expiresAt <= this.options.now()) {
      this.options.expire(candidate.id);
      return;
    }
    if (entry.definition.mode === "fixed") this.options.armDue(entry, this.options.now());
    entry.state = "submitted";
    this.activeOrigin = candidate.id;
    this.options.emit({
      kind: "fired",
      loopId: candidate.id,
      scheduledDueAt: candidate.dueAt,
      submittedAt: this.options.now(),
      snapshot: { ...redactLoop(entry), state: "submitted" },
    });
  }

  private rejected(candidate: Candidate): void {
    const entry = this.settled(candidate);
    if (!entry) return;
    this.readyState = true;
    this.options.fail(entry);
    this.options.armDue(entry, this.options.now());
    this.pump(true); // a candidate only exists while live; pausing clears it (→ stale above)
  }

  /**
   * Retires a settling candidate and returns its live entry, or `undefined` when the
   * settlement is STALE: the loop was cancelled, removed, or the scheduler paused while
   * the write was in flight (each of those clears `candidate`), so nothing may fire.
   */
  private settled(candidate: Candidate): LoopRuntimeEntry | undefined {
    if (this.candidate !== candidate) return undefined;
    this.candidate = undefined;
    return this.options.state.get(candidate.id);
  }
}

function cancelledError(loopId: string): Error {
  return elwoodError("loop_not_found", "Loop was cancelled.", { loopId });
}
