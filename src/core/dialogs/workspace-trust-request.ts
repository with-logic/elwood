/** Shared workspace trust menu identity and request snapshots (PRD §5.13, C-ATTN-07, C-CLAUDE-26). */
import { randomUUID } from "node:crypto";
import type { ElwoodAgentKind } from "../activity/index.ts";
import type { AgentDialogRequest, WorkspaceTrustFacts, WorkspaceTrustTarget } from "./types.ts";

export type WorkspaceTrustMenu<Agent extends ElwoodAgentKind = ElwoodAgentKind> = {
  readonly target: WorkspaceTrustTarget;
  /** Facts the verified native copy states, such as Claude's hooks rows (C-CLAUDE-26). */
  readonly facts: WorkspaceTrustFacts<Agent>;
  readonly dialog: {
    readonly header: string;
    readonly options: readonly { readonly label: string }[];
  };
};

export function workspaceTrustMenuIdentity({ target, dialog }: WorkspaceTrustMenu): string {
  return JSON.stringify([
    target.targetPath,
    target.targetScope,
    dialog.header,
    dialog.options.map(({ label }) => label),
  ]);
}

export function createWorkspaceTrustRequest<Agent extends ElwoodAgentKind>(
  agent: Agent,
  elwoodSessionId: string,
  { target, facts, dialog }: WorkspaceTrustMenu<Agent>,
): AgentDialogRequest<Agent> {
  // Object.assign keeps the agent-specific facts as an intersection the compiler can
  // check; a literal spread or `Object.freeze`'s `Readonly<>` of them does not narrow.
  const request = Object.assign(
    {
      id: randomUUID(),
      elwoodSessionId,
      agent,
      kind: "trust" as const,
      label: "workspace_trust" as const,
      targetPath: target.targetPath,
      targetScope: target.targetScope,
      text: dialog.header,
      choices: Object.freeze(
        dialog.options.map(({ label }) => Object.freeze({ id: randomUUID(), label })),
      ),
    },
    facts,
  );
  Object.freeze(request);
  return request;
}
