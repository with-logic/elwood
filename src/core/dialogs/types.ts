/** Public workspace trust dialog requests, events, and answer options (PRD §5.3, §5.13). */

import type { ElwoodAgentKind } from "../activity/index.ts";

export type ElwoodDialogChoice = {
  readonly id: string;
  readonly label: string;
};

export type WorkspaceTrustTarget = {
  readonly targetPath: string;
  readonly targetScope: "folder" | "repository";
};

/** Request facts only one adapter's native prompt can supply (§5.13). */
export type WorkspaceTrustFacts<Agent extends ElwoodAgentKind> = Agent extends "claude"
  ? {
      /**
       * Claude's prompt showed its hooks rows: trusting the folder runs the hooks its
       * `.claude/settings.json` declares. `false` only means no such rows were shown;
       * Claude before 2.1.332 never shows them (§5.13, C-CLAUDE-26).
       */
      readonly targetDeclaresHooks: boolean;
    }
  : Record<never, never>;

export type ElwoodDialogRequest<Agent extends ElwoodAgentKind = "codex"> = WorkspaceTrustTarget &
  WorkspaceTrustFacts<Agent> & {
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
