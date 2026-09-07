/**
 * Environment decoding and typed value helpers for effective CLI requests.
 * Implements PRD §12A.2/§12A.4 and C-CLI-06/C-CLI-14.
 */

import type { CodexApprovalPolicy, CodexSandboxMode } from "../codex/session-types.ts";
import { claudeReasoningEfforts, codexReasoningEfforts } from "../core/reasoning-effort.ts";
import type { ClaudePermissionMode } from "../core/types.ts";
import {
  type CliAgent,
  type CliEnvironment,
  type CliOutputMode,
  CliValidationError,
  claudePermissionModes,
  cliAgents,
  cliOutputModes,
  codexApprovalPolicies,
  codexSandboxModes,
} from "./types.ts";

export type EnvSettings = {
  readonly agent?: CliAgent;
  readonly output?: CliOutputMode;
  readonly timeout?: string;
  readonly trust?: boolean;
  readonly stateDir?: string;
  readonly verbose?: boolean;
  readonly stream?: boolean;
  readonly persona?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly claudePermissionMode?: ClaudePermissionMode;
  readonly codexSandbox?: CodexSandboxMode;
  readonly codexApprovalPolicy?: CodexApprovalPolicy;
};

export function decodeEnvironment(env: CliEnvironment): EnvSettings {
  return {
    ...envEnum(env, "ELWOOD_AGENT", cliAgents, "agent"),
    ...envEnum(env, "ELWOOD_OUTPUT", cliOutputModes, "output"),
    ...envString(env, "ELWOOD_TIMEOUT", "timeout"),
    ...envBoolean(env, "ELWOOD_TRUST", "trust"),
    ...envString(env, "ELWOOD_STATE_DIR", "stateDir"),
    ...envBoolean(env, "ELWOOD_VERBOSE", "verbose"),
    ...envBoolean(env, "ELWOOD_STREAM", "stream"),
    ...envString(env, "ELWOOD_PERSONA", "persona"),
    ...envString(env, "ELWOOD_MODEL", "model"),
    ...envString(env, "ELWOOD_REASONING_EFFORT", "reasoningEffort"),
    ...envEnum(env, "ELWOOD_CLAUDE_PERMISSION_MODE", claudePermissionModes, "claudePermissionMode"),
    ...envEnum(env, "ELWOOD_CODEX_SANDBOX", codexSandboxModes, "codexSandbox"),
    ...envEnum(env, "ELWOOD_CODEX_APPROVAL_POLICY", codexApprovalPolicies, "codexApprovalPolicy"),
  };
}

export function reasoning(agent: CliAgent, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return choice(
    value,
    undefined,
    undefined,
    agent === "claude" ? claudeReasoningEfforts : codexReasoningEfforts,
    "reasoningEffort",
  );
}

export function choice<V extends string>(
  flag: string | undefined,
  env: V | undefined,
  config: V | undefined,
  valid: readonly V[],
  label: string,
): V | undefined {
  const value = flag ?? env ?? config;
  if (value === undefined) return undefined;
  if (!valid.includes(value as V)) throw usage(`${label} must be one of: ${valid.join(", ")}.`);
  return value as V;
}

export function requiredChoice<V extends string>(
  value: string,
  valid: readonly V[],
  label: string,
): V {
  return choice(value, undefined, undefined, valid, label) as V;
}

export function nonBlank(value: string, label: string): string {
  if (value.trim() === "") throw usage(`${label} must not be empty.`);
  return value;
}

export function optionalNonBlank(value: string | undefined, label: string): string | undefined {
  return value === undefined ? undefined : nonBlank(value, label);
}

export function optional<K extends string, V>(
  value: V | undefined,
  key: K,
): { readonly [P in K]?: V } {
  return value === undefined ? {} : ({ [key]: value } as { readonly [P in K]?: V });
}

export function usage(message: string): CliValidationError {
  return new CliValidationError("invalid_arguments", message);
}

function envString<K extends string>(
  env: CliEnvironment,
  name: string,
  key: K,
): { readonly [P in K]?: string } {
  const value = env[name];
  return value === undefined
    ? {}
    : ({ [key]: nonBlank(value, name) } as { readonly [P in K]?: string });
}
function envEnum<K extends string, V extends string>(
  env: CliEnvironment,
  name: string,
  valid: readonly V[],
  key: K,
): { readonly [P in K]?: V } {
  const value = env[name];
  return value === undefined
    ? {}
    : ({ [key]: choice(value, undefined, undefined, valid, name) } as { readonly [P in K]?: V });
}
function envBoolean<K extends string>(
  env: CliEnvironment,
  name: string,
  key: K,
): { readonly [P in K]?: boolean } {
  const value = env[name];
  if (value === undefined) return {};
  if (value !== "true" && value !== "false") throw usage(`${name} must be true or false.`);
  return { [key]: value === "true" } as { readonly [P in K]?: boolean };
}
