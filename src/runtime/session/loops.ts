/** Shared live-session loop controller for both adapters (PRD §5.9/§9.3). */

import { randomUUID } from "node:crypto";
import type { ControlQueue, ControlSubmissionOrigin } from "../../core/control-queue/index.ts";
import { elwoodError } from "../../core/errors.ts";
import { LoopScheduler } from "../../core/loops/scheduler.ts";
import { scheduleLoopTimer } from "../../core/loops/timers.ts";
import type {
  ElwoodLoopEvent,
  ElwoodLoopRequest,
  ElwoodLoopSnapshot,
} from "../../core/loops/types.ts";
import type { PersistedLoopDefinition } from "../../state/loop-store.ts";
import { writeLoopDefinitions } from "../../state/loop-store.ts";

export type LoopEventEmitter = {
  emit(event: "loop", payload: ElwoodLoopEvent): void;
};

type SessionLoopsInput = {
  readonly stateDir: string;
  readonly elwoodSessionId: string;
  readonly ownsState: () => boolean;
  readonly definitions: readonly PersistedLoopDefinition[];
  readonly queue: ControlQueue;
  readonly emitter: LoopEventEmitter;
};

/** Owns one adapter-neutral scheduler and binds it to session persistence/input. */
export class SessionLoops {
  private readonly scheduler: LoopScheduler;

  constructor(input: SessionLoopsInput) {
    this.scheduler = new LoopScheduler({
      definitions: input.definitions,
      now: Date.now,
      schedule: scheduleLoopTimer,
      createId: randomUUID,
      persist: (definitions) => {
        if (input.ownsState())
          writeLoopDefinitions(input.stateDir, input.elwoodSessionId, definitions);
      },
      submit: (message, loopId, signal) =>
        input.queue.send(message, "message", undefined, {
          origin: { kind: "loop", loopId },
          cancel: {
            signal,
            // §10: loop_submission_failed details identify only the loop id.
            error: () =>
              elwoodError("loop_submission_failed", "Loop was cancelled before submission.", {
                loopId,
              }),
          },
        }),
      emit: (event) => input.emitter.emit("loop", event),
    });
  }

  /** Start durable scheduling only after the session's startup cleanup boundary exists. */
  start(): void {
    this.scheduler.start();
  }

  turnStarted(origin: ControlSubmissionOrigin): void {
    this.scheduler.activity(origin.kind);
  }

  ready(): void {
    this.scheduler.ready();
  }

  running(): void {
    this.scheduler.running();
  }

  pause(): void {
    this.scheduler.pause();
  }

  create(request: ElwoodLoopRequest): ElwoodLoopSnapshot {
    return this.scheduler.create(request);
  }

  list(): readonly ElwoodLoopSnapshot[] {
    return this.scheduler.list();
  }

  cancel(loopId: string): void {
    this.scheduler.cancel(loopId);
  }

  clear(reason: "kill" | "teardown"): void {
    this.scheduler.clear(reason);
  }

  callerActivity(): void {
    this.scheduler.activity("caller");
  }
}
