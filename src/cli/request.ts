/**
 * Resolves flags, environment, config, paths, and prompt into one launch request.
 * Implements PRD §12A.1/§12A.2/§12A.4 and C-CLI-03/C-CLI-04/C-CLI-06/C-CLI-14.
 */

import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { validateImages } from "../core/images/resolve.ts";
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
  type EffectiveRunRequest,
  type ParsedRunCommand,
  type RequestContext,
  type ResolvedRunRequest,
} from "./types.ts";

export async function resolveRunRequest(
  parsed: ParsedRunCommand,
  context: RequestContext,
): Promise<ResolvedRunRequest> {
  const config = readConfig(resolveConfigPath(context.env, context.invocationCwd, context.homeDir));
  const env = decodeEnvironment(context.env);
  const agent = choice(parsed.flags.agent, env.agent, config.agent, cliAgents, "agent") ?? "codex";
  validateSpecificFlags(parsed, env, agent);
  const output =
    choice(parsed.flags.output, env.output, config.output, cliOutputModes, "output") ?? "text";
  const stream = parsed.flags.stream ?? env.stream ?? config.stream ?? false;
  if (stream && output !== "text") throw usage("--stream is valid only with text output.");
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
  const agentConfig = config[agent];
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
    verbose: parsed.flags.verbose ?? env.verbose ?? config.verbose ?? false,
    stream,
    ...(persona !== undefined && { persona: nonBlank(persona, "persona") }),
    ...optional(
      optionalNonBlank(parsed.flags.model ?? env.model ?? agentConfig?.model, "model"),
      "model",
    ),
    ...optional(
      reasoning(
        agent,
        parsed.flags.reasoningEffort ?? env.reasoningEffort ?? agentConfig?.reasoningEffort,
      ),
      "reasoningEffort",
    ),
    ...(agent === "claude" && { permissionMode: permissionMode ?? "dontAsk" }),
    ...(agent === "codex" && {
      sandbox: sandbox ?? "workspace-write",
      approvalPolicy: approvalPolicy ?? "never",
    }),
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

export async function finalizeRunRequest(
  draft: ResolvedRunRequest,
  stored?: { readonly agent: CliAgent; readonly cwd: string },
): Promise<EffectiveRunRequest> {
  if (draft.resume !== undefined && stored === undefined)
    throw usage("Stored session data is required to resolve a resume.");
  if (
    stored !== undefined &&
    draft.explicitAgent !== undefined &&
    draft.explicitAgent !== stored.agent
  )
    throw usage("The explicit agent conflicts with the stored session adapter.");
  const agent = stored?.agent ?? draft.agent;
  const cwd = draft.cwd ?? stored?.cwd;
  if (cwd === undefined) throw usage("The effective workspace could not be resolved.");
  if (!isAbsolute(cwd)) throw usage("The effective workspace must be absolute.");
  const info = await stat(cwd).catch(() => undefined);
  if (info?.isDirectory() !== true)
    throw usage("The effective workspace must be an existing directory.");
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid)
    throw usage("The effective workspace must be owned by the current user.");
  const images = await validateImages(
    draft.imagePaths.map((path) => ({ path: resolve(cwd, nonBlank(path, "image")) })),
  );
  const { imagePaths: _imagePaths, cwd: _cwd, ...rest } = draft;
  return { ...rest, agent, cwd, images };
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
