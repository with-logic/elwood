/**
 * Flag > environment > config > fallback layering for the per-run settings that
 * have no adapter-specific shape: timeout, state directory, persona, model and
 * effort overrides, and the workspace. Implements PRD §12A.4 and C-CLI-03/C-CLI-14.
 */

import { resolve } from "node:path";
import { resolveStateLocation } from "../config/paths.ts";
import type { CliConfig, ParsedRunCommand } from "../types.ts";
import { configKey, layered, type SourcedValue, sourced } from "./sources.ts";
import { type EnvSettings, nonBlank, optionalNonBlank } from "./values.ts";

export type LayeredSettings = {
  readonly timeout: SourcedValue<string>;
  /** Absolute state directory; relative flag/env/config values resolve against the invocation cwd. */
  readonly stateDir: SourcedValue<string>;
  readonly persona: SourcedValue<string>;
  readonly model: SourcedValue<string>;
  readonly effort: SourcedValue<string>;
  /** Absent on resume, which uses the stored workspace (C-CLI-03). */
  readonly cwd: SourcedValue<string>;
};

export type LayerContext = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly invocationCwd: string;
  readonly homeDir: string;
};

export function layeredSettings(
  parsed: ParsedRunCommand,
  env: EnvSettings,
  config: CliConfig,
  configPath: string,
  context: LayerContext,
  resuming: boolean,
): LayeredSettings {
  const flags = parsed.flags;
  const key = (name: string) => configKey(configPath, name);
  const persona = layered(
    sourced(flags.persona, "--persona"),
    sourced(env.persona, "ELWOOD_PERSONA"),
    sourced(resuming ? undefined : config.persona, key("persona")),
    sourced(undefined, "unset"),
  );
  return {
    timeout: layered(
      sourced(flags.timeout, "--timeout"),
      sourced(env.timeout, "ELWOOD_TIMEOUT"),
      sourced(config.timeout, key("timeout")),
      sourced<string>(undefined, "built-in"),
    ),
    stateDir: resolveStateSetting(parsed, env, config, configPath, context),
    persona: sourced(optionalNonBlank(persona.value, "persona"), persona.source),
    model: layered<string>(
      sourced(flags.model, "--model"),
      sourced(env.model, "ELWOOD_MODEL"),
      sourced<string>(undefined, "unset"),
      sourced<string>(undefined, "unset"),
    ),
    effort: layered<string>(
      sourced(flags.reasoningEffort, "--reasoning-effort"),
      sourced(env.reasoningEffort, "ELWOOD_REASONING_EFFORT"),
      sourced<string>(undefined, "unset"),
      sourced<string>(undefined, "unset"),
    ),
    cwd: workspaceSetting(flags.cwd, context.invocationCwd, resuming),
  };
}

function workspaceSetting(
  flag: string | undefined,
  invocationCwd: string,
  resuming: boolean,
): SourcedValue<string> {
  if (flag !== undefined) return sourced(resolve(invocationCwd, nonBlank(flag, "cwd")), "--cwd");
  if (resuming) return sourced<string>(undefined, "stored session");
  return sourced(resolve(invocationCwd), "invocation cwd");
}

/** Whether the invocation itself (flag or environment) set adapter-specific options. */
export function explicitAdapterOptions(
  parsed: ParsedRunCommand,
  env: EnvSettings,
): { readonly claudeOptionsExplicit: boolean; readonly codexOptionsExplicit: boolean } {
  return {
    claudeOptionsExplicit:
      parsed.flags.claudePermissionMode !== undefined || env.claudePermissionMode !== undefined,
    codexOptionsExplicit:
      parsed.flags.codexSandbox !== undefined ||
      parsed.flags.codexApprovalPolicy !== undefined ||
      env.codexSandbox !== undefined ||
      env.codexApprovalPolicy !== undefined,
  };
}

/** Resolve the state path without selecting or validating any agent (C-CLI-24). */
export function resolveStateSetting(
  parsed: ParsedRunCommand,
  env: EnvSettings,
  config: CliConfig,
  configPath: string,
  context: LayerContext,
): SourcedValue<string> {
  const stateLocation = resolveStateLocation(context.env, context.homeDir);
  const state = layered(
    sourced(parsed.flags.stateDir, "--state-dir"),
    sourced(env.stateDir, "ELWOOD_STATE_DIR"),
    sourced(config.stateDir, configKey(configPath, "stateDir")),
    sourced(stateLocation.path, stateLocation.source),
  );
  return sourced(
    state.source === stateLocation.source
      ? state.value!
      : resolve(context.invocationCwd, nonBlank(state.value!, "stateDir")),
    state.source,
  );
}
