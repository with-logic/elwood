/** Public native workspace trust discovery types (PRD §5.13, C-ATTN-07). */

export type ElwoodDialogChoice = {
  readonly id: string;
  readonly label: string;
};

export type WorkspaceTrustTarget = {
  readonly targetPath: string;
  readonly targetScope: "folder" | "repository";
};

export type ElwoodDialogRequest = WorkspaceTrustTarget & {
  readonly id: string;
  readonly elwoodSessionId: string;
  readonly agent: "codex";
  readonly kind: "trust";
  readonly label: "workspace_trust";
  readonly text: string;
  readonly choices: readonly ElwoodDialogChoice[];
};
