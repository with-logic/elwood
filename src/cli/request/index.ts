/** Resolves CLI inputs into a launch request (PRD §12A.1/§12A.2/§12A.4, C-CLI-03/04/06/14/19/21). */

import { resolveConfigLocation } from "../config/paths.ts";
import { readConfigWithStatus } from "../config/store.ts";
import { parseDuration } from "../duration.ts";
import { readPromptInput } from "../input.ts";
import {
  type CliConfig,
  cliAgents,
  cliOutputModes,
  type ParsedRunCommand,
  type RequestContext,
  type ResolvedRunRequest,
} from "../types.ts";
import { type AgentDetector, detectAvailableAgent, selectAgent } from "./agent-detect.ts";
import { explicitAdapterOptions, layeredSettings } from "./layers.ts";
import { ioSettings, optionSettings, resolvePosture } from "./settings.ts";
import { configKey, sourced } from "./sources.ts";
import { validateLifecycle, validateOutput, validateSpecificFlags } from "./validation.ts";
import {
  decodeEnvironment,
  optional,
  optionalNonBlank,
  reasoning,
  requiredChoice,
} from "./values.ts";

export { finalizeRunRequest } from "./finalize.ts";

type SettingsContext = Omit<RequestContext, "stdin">;

export async function resolveRunRequest(
  parsed: ParsedRunCommand,
  context: RequestContext,
  detectAgent: AgentDetector = detectAvailableAgent,
): Promise<ResolvedRunRequest> {
  return {
    ...(await resolveRunSettings(parsed, context, detectAgent)),
    prompt: await readPromptInput(parsed.promptWords, context.stdin),
  };
}

/**
 * Resolve and validate settings without reading prompt input or starting an agent.
 * `detectAgent` runs only when nothing selects the agent for a new session (C-CLI-21).
 */
export async function resolveRunSettings(
  parsed: ParsedRunCommand,
  context: SettingsContext,
  detectAgent: AgentDetector = detectAvailableAgent,
): Promise<ResolvedRunRequest> {
  const useDefaults = parsed.flags.ignoreDefaults !== true;
  const configLocation = resolveConfigLocation(context.env, context.invocationCwd, context.homeDir);
  const configRead = useDefaults
    ? readConfigWithStatus(configLocation.path)
    : { config: { schemaVersion: 1 } as CliConfig, loaded: false };
  const config = configRead.config;
  const env = useDefaults ? decodeEnvironment(context.env) : {};
  const resuming = parsed.flags.resume !== undefined;
  const agentSetting = await selectAgent(
    {
      flag: parsed.flags.agent,
      env: env.agent,
      config: sourced(config.agent, configKey(configLocation.path, "agent")),
      resuming,
    },
    detectAgent,
  );
  const agent = requiredChoice(agentSetting.value!, cliAgents, "agent");
  if (!resuming) validateSpecificFlags(parsed, env, agent, agentSetting.source);
  validateLifecycle(parsed, env);
  const io = ioSettings(parsed, env, config, configLocation.path);
  const output = requiredChoice(io.output.value!, cliOutputModes, "output");
  const debug = parsed.flags.debug ?? false;
  const head = parsed.flags.head ?? false;
  validateOutput(output, io.stream, io.verbose, debug, head);
  const layers = layeredSettings(parsed, env, config, configLocation.path, context, resuming);
  const agentOptions = optionSettings(config, configLocation.path, layers.model, layers.effort);
  const selected = agentOptions.values[agent];
  const posture = resolvePosture(parsed, env, config, configLocation.path, agent);
  return {
    agent,
    ...((parsed.flags.agent !== undefined || env.agent !== undefined) && { explicitAgent: agent }),
    output,
    outputExplicit: parsed.explicit.has("output"),
    ...(layers.timeout.value !== undefined && { timeoutMs: parseDuration(layers.timeout.value) }),
    trust: io.trust.value as boolean,
    stateDir: layers.stateDir.value!,
    verbose: io.verbose.value as boolean,
    stream: io.stream.value as boolean,
    debug,
    head,
    ...optional(layers.persona.value, "persona"),
    ...optional(optionalNonBlank(selected.model, "model"), "model"),
    ...optional(
      resuming ? selected.reasoningEffort : reasoning(agent, selected.reasoningEffort),
      "reasoningEffort",
    ),
    agentOptions: agentOptions.values,
    ...explicitAdapterOptions(parsed, env),
    ...optional(posture.permissionMode, "permissionMode"),
    ...optional(posture.sandbox, "sandbox"),
    ...optional(posture.approvalPolicy, "approvalPolicy"),
    ...optional(layers.cwd.value, "cwd"),
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
        output: io.output.source,
        timeoutMs: layers.timeout.source,
        trust: io.trust.source,
        stateDir: layers.stateDir.source,
        verbose: io.verbose.source,
        stream: io.stream.source,
        debug: debug ? "--debug" : "built-in",
        head: head ? "--head" : "built-in",
        persona: layers.persona.source,
        model: agentOptions.sources[agent].model,
        reasoningEffort: agentOptions.sources[agent].reasoningEffort,
        permissionMode: posture.sources.permissionMode,
        sandbox: posture.sources.sandbox,
        approvalPolicy: posture.sources.approvalPolicy,
        workspace: layers.cwd.source,
      },
      agentOptionSources: agentOptions.sources,
    },
  };
}
