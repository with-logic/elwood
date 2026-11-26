/** Shared workspace trust menu identity and request snapshots (PRD §5.13, C-ATTN-07). */
import { randomUUID } from "node:crypto";
import type { ElwoodAgentKind } from "../activity/index.ts";
import type { ElwoodTrustDialogRequest, WorkspaceTrustTarget } from "./types.ts";

export type WorkspaceTrustMenu = {
  readonly target: WorkspaceTrustTarget;
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
  { target, dialog }: WorkspaceTrustMenu,
): ElwoodTrustDialogRequest<Agent> {
  return Object.freeze({
    id: randomUUID(),
    elwoodSessionId,
    agent,
    kind: "trust",
    label: "workspace_trust",
    targetPath: target.targetPath,
    targetScope: target.targetScope,
    text: dialog.header,
    choices: Object.freeze(
      dialog.options.map(({ label }) => Object.freeze({ id: randomUUID(), label })),
    ),
  });
}
