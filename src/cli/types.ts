/**
 * Shared types for CLI parsing, configuration, and effective requests.
 * Implements PRD §12A.1/§12A.2/§12A.4 and C-CLI-02 through C-CLI-16.
 */

import type { CodexApprovalPolicy, CodexSandboxMode } from "../codex/session/types.ts";
import type { ImageInput } from "../core/images/types.ts";
import type { ClaudeReasoningEffort, CodexReasoningEffort } from "../core/reasoning-effort.ts";
import type { ClaudePermissionMode, TerminalSize } from "../core/types.ts";
import type { ParsedInteractiveCommand, ParsedListCommand } from "./command-types.ts";
import type { CliRequestResolution } from "./request/resolution-types.ts";

export type { CliRequestResolution, CliSettingSources } from "./request/resolution-types.ts";
export { type CliValidationCode, CliValidationError } from "./validation-error.ts";
export const cliAgents = ["claude", "codex"] as const;
/** Human-facing adapter name for diagnostics and progress lines. */
export function agentDisplayName(agent: CliAgent): "Claude" | "Codex" {
  return agent === "claude" ? "Claude" : "Codex";
}
export const cliOutputModes = ["text", "json", "jsonl"] as const;
export const claudePermissionModes = [
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "dontAsk",
  "bypassPermissions",
] as const satisfies readonly ClaudePermissionMode[];
export const codexSandboxModes = [
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const satisfies readonly CodexSandboxMode[];
export const codexApprovalPolicies = [
  "untrusted",
  "on-request",
  "never",
] as const satisfies readonly CodexApprovalPolicy[];

export type CliAgent = (typeof cliAgents)[number];
export type CliOutputMode = (typeof cliOutputModes)[number];
export type CliEnvironment = Readonly<Record<string, string | undefined>>;

export type AgentConfig = {
  readonly model?: string;
  readonly reasoningEffort?: string;
};

export type CliConfig = {
  readonly schemaVersion: 1;
  readonly agent?: CliAgent;
  readonly output?: CliOutputMode;
  readonly timeout?: string;
  readonly trust?: boolean;
  readonly highTrust?: boolean;
  readonly stateDir?: string;
  readonly verbose?: boolean;
  readonly stream?: boolean;
  readonly persona?: string;
  readonly claude?: AgentConfig & { readonly permissionMode?: ClaudePermissionMode };
  readonly codex?: AgentConfig & {
    readonly sandbox?: CodexSandboxMode;
    readonly approvalPolicy?: CodexApprovalPolicy;
  };
};

export type RunFlags = {
  readonly agent?: string;
  readonly output?: string;
  readonly timeout?: string;
  readonly trust?: boolean;
  readonly highTrust?: boolean;
  readonly stateDir?: string;
  readonly verbose?: boolean;
  readonly stream?: boolean;
  readonly debug?: boolean;
  readonly ignoreDefaults?: boolean;
  readonly head?: boolean;
  readonly persona?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly claudePermissionMode?: string;
  readonly codexSandbox?: string;
  readonly codexApprovalPolicy?: string;
  readonly cwd?: string;
  readonly images: readonly string[];
  readonly keep?: boolean;
  readonly showSessionId?: boolean;
  readonly resume?: string;
  readonly ephemeral?: boolean;
};

/** Every `RunFlags` field an explicit long option can set. */
export type RunOptionKey = keyof RunFlags;

export type ParsedRunCommand = {
  readonly command: "run";
  readonly flags: RunFlags;
  readonly explicit: ReadonlySet<RunOptionKey>;
  readonly promptWords: readonly string[];
};

export type ParsedCliCommand =
  | ParsedRunCommand
  | ParsedListCommand<"sessions">
  | ParsedListCommand<"models">
  | ParsedInteractiveCommand
  | { readonly command: "help" }
  | { readonly command: "version" }
  | { readonly command: "config"; readonly args: readonly string[] };

export type PromptStdin = {
  readonly isTTY?: boolean;
  readonly source: AsyncIterable<string | Uint8Array>;
};

export type RequestContext = {
  readonly env: CliEnvironment;
  readonly invocationCwd: string;
  readonly homeDir: string;
  readonly stdin: PromptStdin;
};

export type ResolvedRunRequest = {
  readonly agent: CliAgent;
  readonly explicitAgent?: CliAgent;
  readonly output: CliOutputMode;
  readonly outputExplicit: boolean;
  readonly timeoutMs?: number;
  readonly trust: boolean;
  readonly highTrust: boolean;
  readonly stateDir: string;
  readonly verbose: boolean;
  readonly stream: boolean;
  readonly debug?: boolean;
  readonly head?: boolean;
  readonly initialSize?: TerminalSize;
  readonly persona?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly agentOptions?: Readonly<Record<CliAgent, EffectiveAgentOptions>>;
  readonly claudeOptionsExplicit?: boolean;
  readonly codexOptionsExplicit?: boolean;
  readonly permissionMode?: ClaudePermissionMode;
  readonly sandbox?: CodexSandboxMode;
  readonly approvalPolicy?: CodexApprovalPolicy;
  readonly cwd?: string;
  readonly cwdExplicit?: boolean;
  readonly imagePaths: readonly string[];
  readonly prompt: string;
  readonly keep: boolean;
  readonly showSessionId?: boolean;
  readonly resume?: string;
  readonly ephemeral: boolean;
  readonly resolution?: CliRequestResolution;
};

/**
 * The effective adapter with its effort already narrowed to that adapter's
 * vocabulary (C-CLI-06): `finalizeRunRequest` validates before launch, so the
 * launch mapping never re-checks the value.
 */
export type EffectiveAgentEffort =
  | { readonly agent: "claude"; readonly reasoningEffort?: ClaudeReasoningEffort }
  | { readonly agent: "codex"; readonly reasoningEffort?: CodexReasoningEffort };

export type EffectiveRunRequest = Omit<
  ResolvedRunRequest,
  | "agent"
  | "cwd"
  | "imagePaths"
  | "agentOptions"
  | "claudeOptionsExplicit"
  | "codexOptionsExplicit"
  | "model"
  | "reasoningEffort"
  | "permissionMode"
  | "sandbox"
  | "approvalPolicy"
  | "head"
> & {
  readonly cwd: string;
  readonly images: readonly ImageInput[];
  readonly model?: string;
  readonly permissionMode?: ClaudePermissionMode;
  readonly sandbox?: CodexSandboxMode;
  readonly approvalPolicy?: CodexApprovalPolicy;
} & EffectiveAgentEffort;

export type EffectiveAgentOptions = {
  readonly model?: string;
  readonly reasoningEffort?: string | CodexReasoningEffort;
};
