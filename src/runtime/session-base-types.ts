/**
 * Types and labels shared by the adapter session base class.
 * Implements PRD §5.3 and §5.7 common session semantics.
 */

import type { ElwoodActivityEvent, ElwoodAgentKind } from "../core/activity.ts";
import type { CompactEmitter } from "../core/compact.ts";
import { elwoodError } from "../core/errors.ts";
import type { ElwoodSessionStatus, Unsubscribe } from "../core/types.ts";
import type { LoopEventEmitter } from "./session-loops.ts";

export type { ElwoodAgentKind } from "../core/activity.ts";
export type { SendOptions } from "../core/images/types.ts";
export type { ElwoodLoopRequest, ElwoodLoopSnapshot } from "../core/loops/types.ts";
export type { ModelPickerSpec } from "../core/model-picker.ts";
export type { AgentModelOption } from "../core/model-rows.ts";
export type { PasteGuard } from "../core/session-input.ts";
export type { TerminalReplayBuffer } from "../core/terminal-replay.ts";
export type { ElwoodSessionStatus, ElwoodWarningEvent, TerminalSize } from "../core/types.ts";
export type { PtyProcess } from "../pty/types.ts";
export type { PersistedLoopDefinition } from "../state/loop-store.ts";
export type { SessionRuntime } from "../state/runtime-paths.ts";
export type { SessionRecord } from "../state/store.ts";
export type { ElwoodTerminal } from "../terminal/headless.ts";
export type { AttachDriver, AttachTask, SubmitKind } from "./session-image-attach.ts";
export { terminalStatuses } from "./session-status.ts";
export type { SessionStatusEngine, StatusDecision, StatusEvidenceKind } from "./status-evidence.ts";

type StatusEvent = { readonly elwoodSessionId: string; readonly status: ElwoodSessionStatus };

export type SessionStatusEmitter = CompactEmitter &
  LoopEventEmitter & {
    emit(event: "status", payload: StatusEvent): void;
    emit(event: "activity", payload: ElwoodActivityEvent): void;
    on(event: "activity", handler: (event: ElwoodActivityEvent) => void): Unsubscribe;
  };

export const agentTitles: Readonly<Record<ElwoodAgentKind, string>> = {
  claude: "Claude",
  codex: "Codex",
};

export function notRunningError(agent: ElwoodAgentKind): Error {
  return elwoodError("session_not_running", `${agentTitles[agent]} session is not running.`);
}
