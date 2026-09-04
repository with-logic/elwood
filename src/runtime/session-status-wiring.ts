/** Connects lifecycle status transitions to queues, loops, and cleanup (PRD §5.3/§5.9). */

import type { ElwoodAgentKind } from "../core/activity.ts";
import type { ControlQueue } from "../core/control-queue.ts";
import type { SessionStatusEmitter } from "./session-base-types.ts";
import type { SessionLoops } from "./session-loops.ts";
import { emitStatusEvents } from "./status-emit.ts";
import { SessionStatusEngine } from "./status-evidence.ts";

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
  return new SessionStatusEngine({
    onReady: input.markReady,
    emitStatus: (status) =>
      emitStatusEvents(input.emitter, input.agent, input.elwoodSessionId, status),
    queueRunning: () => {
      input.loops.running();
      input.queue.suspendReadiness();
    },
    queueReady: () => {
      input.loops.ready();
      input.queue.markReady();
    },
    queueBlocked: () => {
      input.loops.running();
      input.queue.suspendReadiness();
    },
    queueClose: () => {
      input.loops.pause();
      input.queue.close();
    },
    cleanup: input.cleanup,
  });
}
