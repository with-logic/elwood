/**
 * Resolves adapter-specific CLI options and their effective setting sources.
 * Implements PRD §12A.2/§12A.4 and C-CLI-06/C-CLI-14/C-CLI-19.
 */

import { configKey, layered, type SourcedValue, sourced } from "./request-sources.ts";
import { choice, type EnvSettings, optional } from "./request-values.ts";
import {
  type CliAgent,
  type CliConfig,
  claudePermissionModes,
  codexApprovalPolicies,
  codexSandboxModes,
  type EffectiveAgentOptions,
  type ParsedRunCommand,
} from "./types.ts";

type AgentOptionResolution = {
  readonly values: Readonly<Record<CliAgent, EffectiveAgentOptions>>;
  readonly sources: Readonly<
    Record<CliAgent, { readonly model: string; readonly reasoningEffort: string }>
  >;
};

export function optionSettings(
  config: CliConfig,
  path: string,
  model: SourcedValue<string>,
  effort: SourcedValue<string>,
): AgentOptionResolution {
  const resolveAgent = (agent: CliAgent) => {
    const agentModel =
      model.value === undefined
        ? sourced(config[agent]?.model, configKey(path, `${agent}.model`))
        : model;
    const agentEffort =
      effort.value === undefined
        ? sourced(config[agent]?.reasoningEffort, configKey(path, `${agent}.reasoningEffort`))
        : effort;
    return {
      values: {
        ...optional(agentModel.value, "model"),
        ...optional(agentEffort.value, "reasoningEffort"),
      },
      sources: {
        model: agentModel.value === undefined ? "unset" : agentModel.source,
        reasoningEffort: agentEffort.value === undefined ? "unset" : agentEffort.source,
      },
    };
  };
  const claude = resolveAgent("claude");
  const codex = resolveAgent("codex");
  return {
    values: { claude: claude.values, codex: codex.values },
    sources: { claude: claude.sources, codex: codex.sources },
  };
}

export function resolvePosture(
  parsed: ParsedRunCommand,
  env: EnvSettings,
  config: CliConfig,
  path: string,
  agent: CliAgent,
) {
  const permission = layered(
    sourced(parsed.flags.claudePermissionMode, "--claude-permission-mode"),
    sourced(env.claudePermissionMode, "ELWOOD_CLAUDE_PERMISSION_MODE"),
    sourced(config.claude?.permissionMode, configKey(path, "claude.permissionMode")),
    sourced(undefined, "unset"),
  );
  const sandbox = layered(
    sourced(parsed.flags.codexSandbox, "--codex-sandbox"),
    sourced(env.codexSandbox, "ELWOOD_CODEX_SANDBOX"),
    sourced(config.codex?.sandbox, configKey(path, "codex.sandbox")),
    sourced(undefined, "unset"),
  );
  const approval = layered(
    sourced(parsed.flags.codexApprovalPolicy, "--codex-approval-policy"),
    sourced(env.codexApprovalPolicy, "ELWOOD_CODEX_APPROVAL_POLICY"),
    sourced(config.codex?.approvalPolicy, configKey(path, "codex.approvalPolicy")),
    sourced(undefined, "unset"),
  );
  const permissionMode = choice(
    permission.value,
    undefined,
    undefined,
    claudePermissionModes,
    "permissionMode",
  );
  const sandboxMode = choice(sandbox.value, undefined, undefined, codexSandboxModes, "sandbox");
  const approvalPolicy = choice(
    approval.value,
    undefined,
    undefined,
    codexApprovalPolicies,
    "approvalPolicy",
  );
  return {
    permissionMode: permissionMode ?? (agent === "claude" ? "dontAsk" : undefined),
    sandbox: sandboxMode ?? (agent === "codex" ? "workspace-write" : undefined),
    approvalPolicy: approvalPolicy ?? (agent === "codex" ? "never" : undefined),
    sources: {
      permissionMode:
        permissionMode === undefined
          ? agent === "claude"
            ? "built-in"
            : "unset"
          : permission.source,
      sandbox:
        sandboxMode === undefined ? (agent === "codex" ? "built-in" : "unset") : sandbox.source,
      approvalPolicy:
        approvalPolicy === undefined ? (agent === "codex" ? "built-in" : "unset") : approval.source,
    },
  };
}
