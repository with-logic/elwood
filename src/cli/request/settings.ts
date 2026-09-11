/**
 * Resolves adapter-specific CLI options and their effective setting sources.
 * Implements PRD §12A.2/§12A.4 and C-CLI-06/C-CLI-14/C-CLI-19.
 */

import {
  type CliAgent,
  type CliConfig,
  claudePermissionModes,
  codexApprovalPolicies,
  codexSandboxModes,
  type EffectiveAgentOptions,
  type ParsedRunCommand,
} from "../types.ts";
import { booleanFlag, configKey, layered, type SourcedValue, sourced } from "./sources.ts";
import { choice, type EnvSettings, optional } from "./values.ts";

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

/** Output protocol and the three built-in-defaulted booleans, each with provenance (C-CLI-14). */
export function ioSettings(
  parsed: ParsedRunCommand,
  env: EnvSettings,
  config: CliConfig,
  path: string,
) {
  const flags = parsed.flags;
  return {
    output: layered(
      sourced(flags.output, "--output"),
      sourced(env.output, "ELWOOD_OUTPUT"),
      sourced(config.output, configKey(path, "output")),
      sourced("text", "built-in"),
    ),
    trust: layered(
      booleanFlag(flags.trust, "--trust", "--no-trust"),
      sourced(env.trust, "ELWOOD_TRUST"),
      sourced(config.trust, configKey(path, "trust")),
      sourced(true, "built-in"),
    ),
    stream: layered(
      booleanFlag(flags.stream, "--stream", "--no-stream"),
      sourced(env.stream, "ELWOOD_STREAM"),
      sourced(config.stream, configKey(path, "stream")),
      sourced(false, "built-in"),
    ),
    verbose: layered(
      booleanFlag(flags.verbose, "--verbose", "--no-verbose"),
      sourced(env.verbose, "ELWOOD_VERBOSE"),
      sourced(config.verbose, configKey(path, "verbose")),
      sourced(false, "built-in"),
    ),
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
  const permissionMode = choice(permission.value, claudePermissionModes, "permissionMode");
  const sandboxMode = choice(sandbox.value, codexSandboxModes, "sandbox");
  const approvalPolicy = choice(approval.value, codexApprovalPolicies, "approvalPolicy");
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
