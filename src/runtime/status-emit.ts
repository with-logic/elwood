/**
 * Status + activity event delivery for a session's applied status change,
 * extracted to keep AgentSessionBase within the file-size cap. A throwing status
 * listener PROPAGATES here by design: the `initial_ready` transition relies on it
 * to trigger its classify-and-release fallback (C-API-42), and turn-start's own
 * persist-first ordering (status-evidence) already prevents a wedge on a throw.
 * Implements PRD §5.3.
 */

import { activityFromStatus, type ElwoodAgentKind } from "../core/activity.ts";
import type { ElwoodSessionStatus } from "../core/types.ts";
import type { SessionStatusEmitter } from "./session-base-types.ts";

export function emitStatusEvents(
  emitter: SessionStatusEmitter,
  agent: ElwoodAgentKind,
  id: string,
  status: ElwoodSessionStatus,
): void {
  emitter.emit("status", { elwoodSessionId: id, status });
  emitter.emit("activity", activityFromStatus(agent, id, status));
}
