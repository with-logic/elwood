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
import type { LaunchOwnership } from "../../state/launch-ownership.ts";
import type { PersistedLoopDefinition } from "../../state/loop-store.ts";
import { writeLoopDefinitions } from "../../state/loop-store.ts";
import { loadRuntimeLoopDefinitions } from "../loop-restore.ts";

export type LoopEventEmitter = {
  emit(event: "loop", payload: ElwoodLoopEvent): void;
};

type SessionLoopsInput = {
  readonly stateDir: string;
  readonly elwoodSessionId: string;
  readonly ownership: Pick<LaunchOwnership, "canPersist" | "onCommit" | "onRevoked">;
  readonly definitions: readonly PersistedLoopDefinition[];
  readonly queue: ControlQueue;
  readonly emitter: LoopEventEmitter;
};

/** Owns one adapter-neutral scheduler and binds it to session persistence/input. */
export class SessionLoops {
  private readonly mayPersistLoops: () => boolean;
  private scheduler: LoopScheduler;
  private active = false;
  private readyWanted = false;
  private clearWasLive = false;

  constructor(input: SessionLoopsInput) {
    this.mayPersistLoops = input.ownership.canPersist;
    this.scheduler = createScheduler(input);
    input.ownership.onCommit(() => {
      const definitions = loadRuntimeLoopDefinitions(input.stateDir, input.elwoodSessionId);
      this.scheduler.pause();
      this.scheduler = createScheduler({ ...input, definitions });
      this.active = true;
      this.start();
    });
    input.ownership.onRevoked(() => this.pause());
  }

  /** Start durable scheduling only after the session's startup cleanup boundary exists. */
  start(): void {
    if (!this.active) return;
    this.scheduler.start();
    if (this.readyWanted) this.scheduler.ready();
  }

  turnStarted(origin: ControlSubmissionOrigin): void {
    this.scheduler.activity(origin.kind);
  }

  ready(): void {
    this.readyWanted = true;
    if (this.active) this.scheduler.ready();
  }

  running(): void {
    this.readyWanted = false;
    this.scheduler.running();
  }

  pause(): void {
    this.active = false;
    this.scheduler.pause();
  }

  create(request: ElwoodLoopRequest): ElwoodLoopSnapshot {
    this.assertMutable();
    return this.scheduler.create(request);
  }

  list(): readonly ElwoodLoopSnapshot[] {
    return this.scheduler.list();
  }

  cancel(loopId: string): void {
    this.assertMutable();
    this.scheduler.cancel(loopId);
  }

  private assertMutable(): void {
    if (!this.mayPersistLoops())
      throw elwoodError("session_not_running", "Session was superseded by a later launch.");
  }

  /** Capture notification eligibility before shutdown pauses timers or waits for ownership. */
  prepareClear(): void {
    this.clearWasLive ||= this.active;
    this.pause();
  }

  clear(reason: "kill" | "teardown"): void {
    this.scheduler.clear(reason, this.clearWasLive);
    this.clearWasLive = false;
  }

  callerActivity(): void {
    this.scheduler.activity("caller");
  }
}

function createScheduler(input: SessionLoopsInput): LoopScheduler {
  return new LoopScheduler({
    definitions: input.definitions,
    now: Date.now,
    schedule: scheduleLoopTimer,
    createId: randomUUID,
    persist: (definitions) => {
      if (input.ownership.canPersist())
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
