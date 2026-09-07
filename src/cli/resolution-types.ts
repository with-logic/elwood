/**
 * Provenance carried from CLI setting resolution into dry-run inspection.
 * Implements PRD §12A.4 and C-CLI-19/C-CLI-20.
 */

export type CliSettingSources = {
  readonly agent: string;
  readonly output: string;
  readonly timeoutMs: string;
  readonly trust: string;
  readonly stateDir: string;
  readonly verbose: string;
  readonly stream: string;
  readonly debug: string;
  readonly head: string;
  readonly persona: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly permissionMode: string;
  readonly sandbox: string;
  readonly approvalPolicy: string;
  readonly workspace: string;
};

export type CliRequestResolution = {
  readonly config: { readonly path: string; readonly source: string; readonly loaded: boolean };
  readonly sources: CliSettingSources;
  readonly agentOptionSources: Readonly<
    Record<"claude" | "codex", { readonly model: string; readonly reasoningEffort: string }>
  >;
};
