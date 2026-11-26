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

/**
 * The requesting agent, with the facts only its native prompt can supply (§5.13). Distributed
 * over `Agent`, and the only source of a request's `agent`, so a request for a union of agents
 * is a union whose `agent` decides its facts: a Claude request always has `disclosesHooks`, and
 * a Codex request never does.
 */
export type WorkspaceTrustFacts<Agent extends ElwoodAgentKind> = Agent extends "claude"
  ? {
      readonly agent: Agent;
      /**
       * Claude's prompt disclosed hooks: trusting the folder runs commands its project
       * settings configure. `false` only means the prompt disclosed none, never that the
       * folder has no hooks (§5.13, C-CLAUDE-26).
       */
      readonly disclosesHooks: boolean;
    }
  : { readonly agent: Agent };

/** One agent's request. Internal code that is generic over the agent builds and holds this. */
export type AgentDialogRequest<Agent extends ElwoodAgentKind> = WorkspaceTrustTarget &
  WorkspaceTrustFacts<Agent> & {
    readonly id: string;
    readonly elwoodSessionId: string;
    readonly kind: "trust";
    readonly label: "workspace_trust";
    readonly text: string;
    readonly choices: readonly ElwoodDialogChoice[];
  };

/**
 * A workspace trust request. For `ElwoodAgentKind` it is a union that narrowing `agent` to
 * `"claude"` resolves to the Claude request, with `disclosesHooks`.
 */
export type ElwoodDialogRequest<Agent extends ElwoodAgentKind = "codex"> =
  AgentDialogRequest<Agent>;

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
