/**
 * Types and labels shared by the adapter session base class.
 * Implements PRD §5.3 and §5.7 common session semantics.
 */

import type { ElwoodActivityEvent, ElwoodAgentKind } from "../core/activity.ts";
import type { CompactEmitter } from "../core/compact.ts";
import type { ElwoodSessionStatus, Unsubscribe } from "../core/types.ts";

type StatusEvent = { readonly elwoodSessionId: string; readonly status: ElwoodSessionStatus };

export type SessionStatusEmitter = CompactEmitter & {
  emit(event: "status", payload: StatusEvent): void;
  emit(event: "activity", payload: ElwoodActivityEvent): void;
  on(event: "activity", handler: (event: ElwoodActivityEvent) => void): Unsubscribe;
};

export const agentTitles: Readonly<Record<ElwoodAgentKind, string>> = {
  claude: "Claude",
  codex: "Codex",
};
