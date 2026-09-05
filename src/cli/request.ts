/**
 * Resolves flags, environment, config, paths, and prompt into one launch request.
 * Implements PRD §12A.1/§12A.2/§12A.4 and C-CLI-03/C-CLI-04/C-CLI-06/C-CLI-14.
 */

import { resolve } from "node:path";
import { resolveConfigPath, resolveStateDir } from "./config/paths.ts";
import { readConfig } from "./config/store.ts";
import { parseDuration } from "./duration.ts";
import { readPromptInput } from "./input.ts";
import {
  choice,
  decodeEnvironment,
  type EnvSettings,
  nonBlank,
  optional,
  reasoning,
  usage,
} from "./request-values.ts";
import {
  type CliAgent,
  claudePermissionModes,
  cliAgents,
  cliOutputModes,
  codexApprovalPolicies,
  codexSandboxModes,
  type ParsedRunCommand,
  type RequestContext,
  type ResolvedRunRequest,
} from "./types.ts";

export { finalizeRunRequest } from "./request-finalize.ts";

export async function resolveRunRequest(
  parsed: ParsedRunCommand,
  context: RequestContext,
): Promise<ResolvedRunRequest> {
  const config = readConfig(resolveConfigPath(context.env, context.invocationCwd, context.homeDir));
  const env = decodeEnvironment(context.env);
  const agent = choice(parsed.flags.agent, env.agent, config.agent, cliAgents, "agent") ?? "codex";
  const resuming = parsed.flags.resume !== undefined;
  if (!resuming) validateSpecificFlags(parsed, env, agent);
  const output =
    choice(parsed.flags.output, env.output, config.output, cliOutputModes, "output") ?? "text";
  const stream = parsed.flags.stream ?? env.stream ?? config.stream ?? false;
  if (stream && output !== "text") throw usage("--stream is valid only with text output.");
  const head = parsed.flags.head ?? false;
  const verbose = parsed.flags.verbose ?? env.verbose ?? config.verbose ?? false;
  if (head && (stream || verbose || output === "jsonl")) {
    throw usage("--head cannot be combined with --stream, --verbose, or JSONL output.");
  }
  validateLifecycle(parsed);
  const timeout = parsed.flags.timeout ?? env.timeout ?? config.timeout;
  const cwd =
    parsed.flags.cwd === undefined
      ? undefined
      : resolve(context.invocationCwd, nonBlank(parsed.flags.cwd, "cwd"));
  const stateDirValue = parsed.flags.stateDir ?? env.stateDir ?? config.stateDir;
  const persona =
    parsed.flags.persona ??
    env.persona ??
    (parsed.flags.resume === undefined ? config.persona : undefined);
  if (
    parsed.flags.resume !== undefined &&
    (parsed.flags.persona !== undefined || env.persona !== undefined)
  ) {
    throw usage("An explicit persona cannot be used when resuming a session.");
  }
  const modelOverride = parsed.flags.model ?? env.model;
  const effortOverride = parsed.flags.reasoningEffort ?? env.reasoningEffort;
  const agentOptions = {
    claude: {
      ...optional(optionalNonBlank(modelOverride ?? config.claude?.model, "model"), "model"),
      ...optional(effortOverride ?? config.claude?.reasoningEffort, "reasoningEffort"),
    },
    codex: {
      ...optional(optionalNonBlank(modelOverride ?? config.codex?.model, "model"), "model"),
      ...optional(effortOverride ?? config.codex?.reasoningEffort, "reasoningEffort"),
    },
  };
  const selected = agentOptions[agent];
  const permissionMode = choice(
    parsed.flags.claudePermissionMode,
    env.claudePermissionMode,
    config.claude?.permissionMode,
    claudePermissionModes,
    "permissionMode",
  );
  const sandbox = choice(
    parsed.flags.codexSandbox,
    env.codexSandbox,
    config.codex?.sandbox,
    codexSandboxModes,
    "sandbox",
  );
  const approvalPolicy = choice(
    parsed.flags.codexApprovalPolicy,
    env.codexApprovalPolicy,
    config.codex?.approvalPolicy,
    codexApprovalPolicies,
    "approvalPolicy",
  );
  return {
    agent,
    ...((parsed.flags.agent !== undefined || env.agent !== undefined) && { explicitAgent: agent }),
    output,
    outputExplicit: parsed.explicit.has("output"),
    ...(timeout !== undefined && { timeoutMs: parseDuration(timeout) }),
    trust: parsed.flags.trust ?? env.trust ?? config.trust ?? true,
    stateDir:
      stateDirValue === undefined
        ? resolveStateDir(context.env, context.homeDir)
        : resolve(context.invocationCwd, nonBlank(stateDirValue, "stateDir")),
    verbose,
    stream,
    head,
    ...(persona !== undefined && { persona: nonBlank(persona, "persona") }),
    ...optional(selected.model, "model"),
    ...optional(
      resuming ? selected.reasoningEffort : reasoning(agent, selected.reasoningEffort),
      "reasoningEffort",
    ),
    agentOptions,
    claudeOptionsExplicit:
      parsed.flags.claudePermissionMode !== undefined || env.claudePermissionMode !== undefined,
    codexOptionsExplicit:
      parsed.flags.codexSandbox !== undefined ||
      parsed.flags.codexApprovalPolicy !== undefined ||
      env.codexSandbox !== undefined ||
      env.codexApprovalPolicy !== undefined,
    ...optional(permissionMode ?? (agent === "claude" ? "dontAsk" : undefined), "permissionMode"),
    ...optional(sandbox ?? (agent === "codex" ? "workspace-write" : undefined), "sandbox"),
    ...optional(approvalPolicy ?? (agent === "codex" ? "never" : undefined), "approvalPolicy"),
    ...(cwd === undefined
      ? parsed.flags.resume === undefined
        ? { cwd: resolve(context.invocationCwd) }
        : {}
      : { cwd }),
    imagePaths: parsed.flags.images,
    prompt: await readPromptInput(parsed.promptWords, context.stdin),
    keep: parsed.flags.keep ?? false,
    ...optional(optionalNonBlank(parsed.flags.resume, "resume"), "resume"),
    ephemeral: parsed.flags.ephemeral ?? false,
  };
}

function validateSpecificFlags(parsed: ParsedRunCommand, env: EnvSettings, agent: CliAgent): void {
  if (
    agent === "codex" &&
    (parsed.flags.claudePermissionMode !== undefined || env.claudePermissionMode !== undefined)
  )
    throw usage("Claude permission mode is incompatible with Codex.");
  if (
    agent === "claude" &&
    (parsed.flags.codexSandbox !== undefined ||
      parsed.flags.codexApprovalPolicy !== undefined ||
      env.codexSandbox !== undefined ||
      env.codexApprovalPolicy !== undefined)
  )
    throw usage("Codex launch options are incompatible with Claude.");
}
function validateLifecycle(parsed: ParsedRunCommand): void {
  if (parsed.flags.keep && parsed.flags.ephemeral)
    throw usage("--keep and --ephemeral cannot be combined.");
  if (parsed.flags.ephemeral && parsed.flags.resume === undefined)
    throw usage("--ephemeral requires --resume.");
  if (parsed.flags.keep && parsed.flags.resume !== undefined)
    throw usage("--keep is only valid for a new session.");
}
function optionalNonBlank(value: string | undefined, label: string): string | undefined {
  return value === undefined ? undefined : nonBlank(value, label);
}
