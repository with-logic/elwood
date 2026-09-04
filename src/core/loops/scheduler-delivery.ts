/**
 * Serialized due-loop selection and submission settlement for the loop scheduler.
 * Implements PRD §5.9 and C-LOOP-08/C-LOOP-09/C-LOOP-17.
 */

import { elwoodError } from "../errors.ts";
import type {
  LoopRuntimeEntry,
  LoopSchedulerOptions,
  LoopSchedulerState,
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
    const candidate = {
      id: entry.definition.id,
      dueAt: entry.dueAt as number,
      abort: new AbortController(),
    };
    this.candidate = candidate;
    this.readyState = false;
    this.options.submit(entry.definition.message, candidate.id, candidate.abort.signal).then(
      () => this.submitted(candidate),
      () => this.rejected(candidate, live),
    );
  }

  cancel(loopId: string): void {
    if (this.candidate?.id === loopId) {
      const candidate = this.candidate;
      this.candidate = undefined;
      this.readyState = true;
      candidate.abort.abort(cancelledError(loopId));
    }
    if (this.activeOrigin === loopId) this.activeOrigin = undefined;
  }

  cancelIf(predicate: (loopId: string) => boolean): void {
    if (this.candidate && predicate(this.candidate.id)) this.cancel(this.candidate.id);
    if (this.activeOrigin && predicate(this.activeOrigin)) this.activeOrigin = undefined;
  }

  pause(): void {
    this.readyState = false;
    this.candidate?.abort.abort(cancelledError(this.candidate.id));
    this.candidate = this.activeOrigin = undefined;
  }

  private submitted(candidate: Candidate): void {
    if (this.candidate !== candidate) return;
    this.candidate = undefined;
    const entry = this.options.state.get(candidate.id);
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
      snapshot: submittedSnapshot(entry),
    });
  }

  private rejected(candidate: Candidate, live: boolean): void {
    if (this.candidate !== candidate) return;
    this.candidate = undefined;
    const entry = this.options.state.get(candidate.id);
    if (!(entry && live)) return;
    this.readyState = true;
    this.options.fail(entry);
    this.options.armDue(entry, this.options.now());
    this.pump(live);
  }
}

function submittedSnapshot(entry: LoopRuntimeEntry) {
  const { message: _message, ...definition } = entry.definition;
  return { ...definition, state: "submitted" as const };
}

function cancelledError(loopId: string): Error {
  return elwoodError("loop_not_found", "Loop was cancelled.", { loopId });
}
