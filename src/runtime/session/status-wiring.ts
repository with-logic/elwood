/**
 * Connects lifecycle status transitions to the control queue, loops, event
 * delivery, and cleanup (PRD §5.3/§5.9, C-API-42). Status and activity events are
 * emitted here; a throwing status listener PROPAGATES by design — the
 * `initial_ready` transition relies on it to trigger its release-and-warn fallback.
 * The engine commits its live `current` status BEFORE emitting, so a throw here can
 * never leave the emitted event disagreeing with that live status (§8.2).
 */

import {
  activityFromStatus,
  type ElwoodActivityEvent,
  type ElwoodAgentKind,
} from "../../core/activity/index.ts";
import type { CompactEmitter } from "../../core/compact.ts";
import type { ControlQueue } from "../../core/control-queue/index.ts";
import type { ElwoodSessionStatus, Unsubscribe } from "../../core/types.ts";
import { SessionStatusEngine } from "../status-evidence.ts";
import type { LoopEventEmitter, SessionLoops } from "./loops.ts";

type StatusEvent = { readonly elwoodSessionId: string; readonly status: ElwoodSessionStatus };

/** The emitter surface a session's status, compact, loop, and activity wiring needs. */
export type SessionStatusEmitter = CompactEmitter &
  LoopEventEmitter & {
    emit(event: "status", payload: StatusEvent): void;
    emit(event: "activity", payload: ElwoodActivityEvent): void;
    on(event: "activity", handler: (event: ElwoodActivityEvent) => void): Unsubscribe;
  };

type StatusWiringInput = {
  readonly agent: ElwoodAgentKind;
  readonly elwoodSessionId: string;
  readonly emitter: SessionStatusEmitter;
  readonly queue: ControlQueue;
  readonly loops: SessionLoops;
  readonly markReady: () => void;
  readonly cleanup: () => void;
};

export function createSessionStatusEngine(input: StatusWiringInput): SessionStatusEngine {
  // Both a turn in progress and a blocking dialog suspend delivery the same way:
  // the queue stops draining and due loops wait (§5.9: "a due loop waits while the
  // session is running, blocked, or otherwise unable to accept a message"). Neither
  // implies a NEW turn — that is `turnStarted`, driven by the queue's own submission.
  const suspend = () => {
    input.loops.running();
    input.queue.suspendReadiness();
  };
  return new SessionStatusEngine({
    onReady: input.markReady,
    emitStatus: (status) =>
      emitStatusEvents(input.emitter, input.agent, input.elwoodSessionId, status),
    queueRunning: suspend,
    queueReady: () => {
      input.loops.ready();
      input.queue.markReady();
    },
    queueBlocked: suspend,
    queueClose: () => {
      input.loops.pause();
      input.queue.close();
    },
    cleanup: input.cleanup,
  });
}

/** Deliver the status event and its derived activity event (a listener throw propagates). */
export function emitStatusEvents(
  emitter: SessionStatusEmitter,
  agent: ElwoodAgentKind,
  id: string,
  status: ElwoodSessionStatus,
): void {
  emitter.emit("status", { elwoodSessionId: id, status });
  emitter.emit("activity", activityFromStatus(agent, id, status));
}
