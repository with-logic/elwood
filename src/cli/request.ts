/** Resolves CLI inputs into a launch request (PRD §12A.1/§12A.2/§12A.4, C-CLI-03/04/06/14/19). */

import { resolve } from "node:path";
import { resolveConfigLocation, resolveStateLocation } from "./config/paths.ts";
import { readConfigWithStatus } from "./config/store.ts";
import { parseDuration } from "./duration.ts";
import { readPromptInput } from "./input.ts";
import { optionSettings, resolvePosture } from "./request-settings.ts";
import { booleanFlag, configKey, layered, sourced } from "./request-sources.ts";
import { validateLifecycle, validateOutput, validateSpecificFlags } from "./request-validation.ts";
import {
  decodeEnvironment,
  nonBlank,
  optional,
  optionalNonBlank,
  reasoning,
  requiredChoice,
} from "./request-values.ts";
import {
  type CliConfig,
  cliAgents,
  cliOutputModes,
  type ParsedRunCommand,
  type RequestContext,
  type ResolvedRunRequest,
} from "./types.ts";

export { finalizeRunRequest } from "./request-finalize.ts";

type SettingsContext = Omit<RequestContext, "stdin">;

export async function resolveRunRequest(
  parsed: ParsedRunCommand,
  context: RequestContext,
): Promise<ResolvedRunRequest> {
  return {
    ...resolveRunSettings(parsed, context),
    prompt: await readPromptInput(parsed.promptWords, context.stdin),
  };
}

/** Resolve and validate settings without reading prompt input or starting an agent. */
export function resolveRunSettings(
  parsed: ParsedRunCommand,
  context: SettingsContext,
): ResolvedRunRequest {
  const useDefaults = parsed.flags.ignoreDefaults !== true;
  const configLocation = resolveConfigLocation(context.env, context.invocationCwd, context.homeDir);
  const configRead = useDefaults
    ? readConfigWithStatus(configLocation.path)
    : { config: { schemaVersion: 1 } as CliConfig, loaded: false };
  const config = configRead.config;
  const env = useDefaults ? decodeEnvironment(context.env) : {};
  const configSource = (key: string) => configKey(configLocation.path, key);
  const agentSetting = layered(
    sourced(parsed.flags.agent, "--agent"),
    sourced(env.agent, "ELWOOD_AGENT"),
    sourced(config.agent, configSource("agent")),
    sourced("codex", "built-in"),
  );
  const agent = requiredChoice(agentSetting.value!, cliAgents, "agent");
  const resuming = parsed.flags.resume !== undefined;
  if (!resuming) validateSpecificFlags(parsed, env, agent);
  validateLifecycle(parsed, env);
  const outputSetting = layered(
    sourced(parsed.flags.output, "--output"),
    sourced(env.output, "ELWOOD_OUTPUT"),
    sourced(config.output, configSource("output")),
    sourced("text", "built-in"),
  );
  const output = requiredChoice(outputSetting.value!, cliOutputModes, "output");
  const trustSetting = layered(
    booleanFlag(parsed.flags.trust, "--trust", "--no-trust"),
    sourced(env.trust, "ELWOOD_TRUST"),
    sourced(config.trust, configSource("trust")),
    sourced(true, "built-in"),
  );
  const streamSetting = layered(
    booleanFlag(parsed.flags.stream, "--stream", "--no-stream"),
    sourced(env.stream, "ELWOOD_STREAM"),
    sourced(config.stream, configSource("stream")),
    sourced(false, "built-in"),
  );
  const verboseSetting = layered(
    booleanFlag(parsed.flags.verbose, "--verbose", "--no-verbose"),
    sourced(env.verbose, "ELWOOD_VERBOSE"),
    sourced(config.verbose, configSource("verbose")),
    sourced(false, "built-in"),
  );
  const debug = parsed.flags.debug ?? false;
  const head = parsed.flags.head ?? false;
  validateOutput(output, streamSetting, verboseSetting, debug, head);
  const timeoutSetting = layered(
    sourced(parsed.flags.timeout, "--timeout"),
    sourced(env.timeout, "ELWOOD_TIMEOUT"),
    sourced(config.timeout, configSource("timeout")),
    sourced(undefined, "built-in"),
  );
  const stateLocation = resolveStateLocation(context.env, context.homeDir);
  const stateSetting = layered(
    sourced(parsed.flags.stateDir, "--state-dir"),
    sourced(env.stateDir, "ELWOOD_STATE_DIR"),
    sourced(config.stateDir, configSource("stateDir")),
    sourced(stateLocation.path, stateLocation.source),
  );
  const personaSetting = layered(
    sourced(parsed.flags.persona, "--persona"),
    sourced(env.persona, "ELWOOD_PERSONA"),
    sourced(resuming ? undefined : config.persona, configSource("persona")),
    sourced(undefined, "unset"),
  );
  const modelOverride = layered<string>(
    sourced(parsed.flags.model, "--model"),
    sourced(env.model, "ELWOOD_MODEL"),
    sourced<string>(undefined, "unset"),
    sourced<string>(undefined, "unset"),
  );
  const effortOverride = layered<string>(
    sourced(parsed.flags.reasoningEffort, "--reasoning-effort"),
    sourced(env.reasoningEffort, "ELWOOD_REASONING_EFFORT"),
    sourced<string>(undefined, "unset"),
    sourced<string>(undefined, "unset"),
  );
  const agentOptions = optionSettings(config, configLocation.path, modelOverride, effortOverride);
  const selected = agentOptions.values[agent];
  const posture = resolvePosture(parsed, env, config, configLocation.path, agent);
  const cwdSetting =
    parsed.flags.cwd === undefined
      ? resuming
        ? sourced(undefined, "stored session")
        : sourced(resolve(context.invocationCwd), "invocation cwd")
      : sourced(resolve(context.invocationCwd, nonBlank(parsed.flags.cwd, "cwd")), "--cwd");
  const stateDir = stateSetting.value!;
  return {
    agent,
    ...((parsed.flags.agent !== undefined || env.agent !== undefined) && { explicitAgent: agent }),
    output,
    outputExplicit: parsed.explicit.has("output"),
    ...(timeoutSetting.value !== undefined && { timeoutMs: parseDuration(timeoutSetting.value) }),
    trust: trustSetting.value as boolean,
    stateDir:
      stateSetting.source === stateLocation.source
        ? stateDir
        : resolve(context.invocationCwd, nonBlank(stateDir, "stateDir")),
    verbose: verboseSetting.value as boolean,
    stream: streamSetting.value as boolean,
    debug,
    head,
    ...(personaSetting.value !== undefined && {
      persona: nonBlank(personaSetting.value, "persona"),
    }),
    ...optional(optionalNonBlank(selected.model, "model"), "model"),
    ...optional(
      resuming ? selected.reasoningEffort : reasoning(agent, selected.reasoningEffort),
      "reasoningEffort",
    ),
    agentOptions: agentOptions.values,
    claudeOptionsExplicit:
      parsed.flags.claudePermissionMode !== undefined || env.claudePermissionMode !== undefined,
    codexOptionsExplicit:
      parsed.flags.codexSandbox !== undefined ||
      parsed.flags.codexApprovalPolicy !== undefined ||
      env.codexSandbox !== undefined ||
      env.codexApprovalPolicy !== undefined,
    ...optional(posture.permissionMode, "permissionMode"),
    ...optional(posture.sandbox, "sandbox"),
    ...optional(posture.approvalPolicy, "approvalPolicy"),
    ...optional(cwdSetting.value, "cwd"),
    cwdExplicit: parsed.explicit.has("cwd"),
    imagePaths: parsed.flags.images,
    prompt: "",
    keep: parsed.flags.keep ?? false,
    ...optional(optionalNonBlank(parsed.flags.resume, "resume"), "resume"),
    ephemeral: parsed.flags.ephemeral ?? false,
    resolution: {
      config: { ...configLocation, loaded: configRead.loaded },
      sources: {
        agent: agentSetting.source,
        output: outputSetting.source,
        timeoutMs: timeoutSetting.source,
        trust: trustSetting.source,
        stateDir: stateSetting.source,
        verbose: verboseSetting.source,
        stream: streamSetting.source,
        debug: debug ? "--debug" : "built-in",
        head: head ? "--head" : "built-in",
        persona: personaSetting.source,
        model: agentOptions.sources[agent].model,
        reasoningEffort: agentOptions.sources[agent].reasoningEffort,
        permissionMode: posture.sources.permissionMode,
        sandbox: posture.sources.sandbox,
        approvalPolicy: posture.sources.approvalPolicy,
        workspace: cwdSetting.source,
      },
      agentOptionSources: agentOptions.sources,
    },
  };
}
