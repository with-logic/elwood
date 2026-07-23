/**
 * Status + activity event delivery for a session's applied status change,
 * extracted to keep AgentSessionBase within the file-size cap. A throwing status
 * listener PROPAGATES here by design: the `initial_ready` transition relies on it
 * to trigger its classify-and-release fallback (C-API-42). The status engine commits
 * the live in-memory `current` status BEFORE calling this, so a throw here can never
 * leave the emitted event disagreeing with that live status (status is live-only,
 * never persisted, §8.2; status-evidence.apply). Implements PRD §5.3.
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
