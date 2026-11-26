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
 * A native workspace trust question (C-ATTN-07, C-ATTN-08). For `ElwoodAgentKind` it is a
 * union that narrowing `agent` to `"claude"` resolves to the Claude request, with
 * `disclosesHooks`.
 */
export type ElwoodTrustDialogRequest<Agent extends ElwoodAgentKind = "codex"> =
  AgentDialogRequest<Agent>;

/**
 * Codex's update offer, once Elwood's own skip does not answer it (C-ATTN-12). Claude
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

/**
 * A native dialog request, discriminated by `kind`. Only Codex sessions list and announce
 * updates, which hosts answer at the terminal rather than with `answerDialog()`.
 */
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
