/** Public native workspace trust discovery types (PRD §5.13, C-ATTN-07). */

import type { ElwoodAgentKind } from "../activity/index.ts";

export type ElwoodDialogChoice = {
  readonly id: string;
  readonly label: string;
};

export type WorkspaceTrustTarget = {
  readonly targetPath: string;
  readonly targetScope: "folder" | "repository";
};

export type ElwoodDialogRequest<Agent extends ElwoodAgentKind = "codex"> = WorkspaceTrustTarget & {
  readonly id: string;
  readonly elwoodSessionId: string;
  readonly agent: Agent;
  readonly kind: "trust";
  readonly label: "workspace_trust";
  readonly text: string;
  readonly choices: readonly ElwoodDialogChoice[];
};

export type ElwoodDialogEvent<Agent extends ElwoodAgentKind = "codex"> = {
  readonly request: ElwoodDialogRequest<Agent>;
} & (
  | { readonly phase: "raised" }
  | { readonly phase: "closed"; readonly reason: "cleared" | "replaced" | "unavailable" }
);

export type ElwoodDialogAnswerOptions = {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
};
