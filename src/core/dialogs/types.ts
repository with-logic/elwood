/** Public native dialog requests, events, and answer options (PRD §5.3, §5.13). */

import type { ElwoodAgentKind } from "../activity/index.ts";

export type ElwoodDialogChoice = {
  readonly id: string;
  readonly label: string;
};

export type WorkspaceTrustTarget = {
  readonly targetPath: string;
  readonly targetScope: "folder" | "repository";
};

/** A native workspace trust question (C-ATTN-07, C-ATTN-08). */
export type ElwoodTrustDialogRequest<Agent extends ElwoodAgentKind = "codex"> =
  WorkspaceTrustTarget & {
    readonly id: string;
    readonly elwoodSessionId: string;
    readonly agent: Agent;
    readonly kind: "trust";
    readonly label: "workspace_trust";
    readonly text: string;
    readonly choices: readonly ElwoodDialogChoice[];
  };

/**
 * Codex's update offer, once Elwood's own skip does not answer it (C-ATTN-10). Claude
 * draws no update screen, so only Codex sessions report one.
 */
export type ElwoodUpdateDialogRequest = {
  readonly id: string;
  readonly elwoodSessionId: string;
  readonly agent: "codex";
  readonly kind: "update";
  readonly label: "codex_update";
  /** The installed and offered Codex versions, when the banner names them. */
  readonly versions?: { readonly installed: string; readonly offered: string };
  readonly text: string;
  readonly choices: readonly ElwoodDialogChoice[];
};

export type ElwoodDialogRequest<Agent extends ElwoodAgentKind = "codex"> =
  | ElwoodTrustDialogRequest<Agent>
  | (Agent extends "codex" ? ElwoodUpdateDialogRequest : never);

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
