/**
 * Strict version-1 global CLI configuration codec and dotted-key helpers.
 * Implements PRD §12A.4 and C-CLI-13/C-CLI-14.
 */

import { claudeReasoningEfforts, codexReasoningEfforts } from "../../core/reasoning-effort.ts";
import { parseDuration } from "../duration.ts";
import {
  type CliConfig,
  CliValidationError,
  claudePermissionModes,
  cliAgents,
  cliOutputModes,
  codexApprovalPolicies,
  codexSandboxModes,
} from "../types.ts";
import { type ConfigKey, configKeys } from "./keys.ts";

const topKeys = [
  "schemaVersion",
  "agent",
  "output",
  "timeout",
  "trust",
  "stateDir",
  "verbose",
  "stream",
  "persona",
  "claude",
  "codex",
] as const;

export function parseConfigText(text: string): CliConfig {
  try {
    return decodeConfig(JSON.parse(text));
  } catch (error) {
    if (error instanceof CliValidationError) throw error;
    throw invalid("Config is not valid JSON.");
  }
}

export function decodeConfig(value: unknown): CliConfig {
  const object = record(value, "config");
  exactKeys(object, topKeys, "config");
  if (object["schemaVersion"] !== 1) throw invalid("Config schemaVersion must be 1.");
  return {
    schemaVersion: 1,
    ...optionalEnum(object, "agent", cliAgents),
    ...optionalEnum(object, "output", cliOutputModes),
    ...optionalDuration(object),
    ...optionalBoolean(object, "trust"),
    ...optionalString(object, "stateDir"),
    ...optionalBoolean(object, "verbose"),
    ...optionalBoolean(object, "stream"),
    ...optionalString(object, "persona"),
    ...optionalClaude(object),
    ...optionalCodex(object),
  };
}

export function parseConfigValue(key: string, value: string): unknown {
  assertConfigKey(key);
  if (key === "schemaVersion") {
    if (value !== "1") throw invalid("schemaVersion must be 1.");
    return 1;
  }
  if (key === "trust" || key === "verbose" || key === "stream") return strictBoolean(value);
  if (key === "agent") return oneOf(value, cliAgents, key);
  if (key === "output") return oneOf(value, cliOutputModes, key);
  if (key === "timeout") {
    parseDuration(value, "invalid_config");
    return value;
  }
  if (key === "claude.reasoningEffort") return oneOf(value, claudeReasoningEfforts, key);
  if (key === "claude.permissionMode") return oneOf(value, claudePermissionModes, key);
  if (key === "codex.reasoningEffort") return oneOf(value, codexReasoningEfforts, key);
  if (key === "codex.sandbox") return oneOf(value, codexSandboxModes, key);
  if (key === "codex.approvalPolicy") return oneOf(value, codexApprovalPolicies, key);
  if (value.trim() === "") throw invalid(`${key} must not be empty.`);
  return value;
}

export function getConfigValue(config: CliConfig, key: string): unknown {
  assertConfigKey(key);
  if (!key.includes(".")) return config[key as keyof CliConfig];
  const [group, child] = key.split(".") as ["claude" | "codex", string];
  return config[group]?.[child as keyof NonNullable<CliConfig[typeof group]>];
}

export function setConfigValue(config: CliConfig, key: string, raw: string): CliConfig {
  const value = parseConfigValue(key, raw);
  if (!key.includes(".")) return decodeConfig({ ...config, [key]: value });
  const [group, child] = key.split(".") as ["claude" | "codex", string];
  return decodeConfig({ ...config, [group]: { ...config[group], [child]: value } });
}

export function unsetConfigValue(config: CliConfig, key: string): CliConfig {
  assertConfigKey(key);
  if (key === "schemaVersion") return config;
  const copy: Record<string, unknown> = structuredClone(config);
  if (key.includes(".")) {
    const [group, child] = key.split(".") as [string, string];
    const nested = copy[group] as Record<string, unknown> | undefined;
    if (nested !== undefined) Reflect.deleteProperty(nested, child);
    if (nested !== undefined && Object.keys(nested).length === 0)
      Reflect.deleteProperty(copy, group);
  } else {
    Reflect.deleteProperty(copy, key);
  }
  return decodeConfig(copy);
}

function optionalClaude(object: Record<string, unknown>): {
  readonly claude?: NonNullable<CliConfig["claude"]>;
} {
  if (!("claude" in object)) return {};
  const value = record(object["claude"], "claude");
  exactKeys(value, ["model", "reasoningEffort", "permissionMode"], "claude");
  return {
    claude: {
      ...optionalString(value, "model"),
      ...optionalEnum(value, "reasoningEffort", claudeReasoningEfforts),
      ...optionalEnum(value, "permissionMode", claudePermissionModes),
    },
  };
}

function optionalCodex(object: Record<string, unknown>): {
  readonly codex?: NonNullable<CliConfig["codex"]>;
} {
  if (!("codex" in object)) return {};
  const value = record(object["codex"], "codex");
  exactKeys(value, ["model", "reasoningEffort", "sandbox", "approvalPolicy"], "codex");
  return {
    codex: {
      ...optionalString(value, "model"),
      ...optionalEnum(value, "reasoningEffort", codexReasoningEfforts),
      ...optionalEnum(value, "sandbox", codexSandboxModes),
      ...optionalEnum(value, "approvalPolicy", codexApprovalPolicies),
    },
  };
}

function optionalDuration(object: Record<string, unknown>): { readonly timeout?: string } {
  const result = optionalString(object, "timeout");
  if (result.timeout !== undefined) parseDuration(result.timeout, "invalid_config");
  return result;
}
function optionalString<K extends string>(
  object: Record<string, unknown>,
  key: K,
): { readonly [P in K]?: string } {
  if (!(key in object)) return {};
  const value = object[key];
  if (typeof value !== "string" || value.trim() === "")
    throw invalid(`${key} must be a non-empty string.`);
  return { [key]: value } as { readonly [P in K]?: string };
}
function optionalBoolean<K extends string>(
  object: Record<string, unknown>,
  key: K,
): { readonly [P in K]?: boolean } {
  if (!(key in object)) return {};
  if (typeof object[key] !== "boolean") throw invalid(`${key} must be true or false.`);
  return { [key]: object[key] } as { readonly [P in K]?: boolean };
}
function optionalEnum<K extends string, V extends string>(
  object: Record<string, unknown>,
  key: K,
  valid: readonly V[],
): { readonly [P in K]?: V } {
  if (!(key in object)) return {};
  return { [key]: oneOf(object[key], valid, key) } as { readonly [P in K]?: V };
}
function oneOf<V extends string>(value: unknown, valid: readonly V[], key: string): V {
  if (typeof value !== "string" || !valid.includes(value as V))
    throw invalid(`${key} must be one of: ${valid.join(", ")}.`);
  return value as V;
}
function strictBoolean(value: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw invalid("Boolean values must be true or false.");
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw invalid(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function exactKeys(object: Record<string, unknown>, valid: readonly string[], label: string): void {
  const unknown = Object.keys(object).find((key) => !valid.includes(key));
  if (unknown !== undefined) throw invalid(`Unknown ${label} key: ${unknown}.`);
}
function assertConfigKey(key: string): asserts key is ConfigKey {
  if (!configKeys.includes(key as ConfigKey)) throw invalid(`Unknown config key: ${key}.`);
}
function invalid(message: string): CliValidationError {
  return new CliValidationError("invalid_config", message);
}
