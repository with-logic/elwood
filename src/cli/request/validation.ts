/**
 * Validates cross-setting CLI compatibility with actionable recovery guidance.
 * Implements PRD §12A.1/§12A.2/§12A.5 and C-CLI-03/C-CLI-06/C-CLI-20.
 */

import {
  agentDisplayName,
  type CliAgent,
  type CliOutputMode,
  type ParsedRunCommand,
} from "../types.ts";
import { autoDetectedSource } from "./agent-detect.ts";
import type { SourcedValue } from "./sources.ts";
import type { EnvSettings } from "./values.ts";
import { usage } from "./values.ts";

/**
 * Reject the other adapter's options for a new session. `agentSource` is the
 * agent's provenance: an auto-detected agent is named as such and the recovery
 * also offers selecting the other adapter, since nothing chose this one.
 */
export function validateSpecificFlags(
  parsed: ParsedRunCommand,
  env: EnvSettings,
  agent: CliAgent,
  agentSource: string,
): void {
  const sources = adapterConflictSources(parsed, env, agent);
  if (sources.length === 0) return;
  const name = agentDisplayName(agent);
  if (agentSource !== autoDetectedSource) throw usage(settingConflict(sources, name));
  const other: CliAgent = agent === "claude" ? "codex" : "claude";
  const conflict = settingConflict(sources, `the auto-detected ${name} agent`);
  throw usage(`${conflict.slice(0, -1)}, or select --agent ${other}.`);
}

export function validateLifecycle(parsed: ParsedRunCommand, env: EnvSettings): void {
  if (parsed.flags.keep && parsed.flags.ephemeral)
    throw usage("--keep and --ephemeral cannot be combined.");
  if (parsed.flags.ephemeral && parsed.flags.resume === undefined)
    throw usage("--ephemeral requires --resume.");
  if (parsed.flags.keep && parsed.flags.resume !== undefined)
    throw usage("--keep is only valid for a new session.");
  if (parsed.flags.cwd !== undefined && parsed.flags.resume !== undefined)
    throw usage("--cwd cannot be used with --resume; resume uses the stored workspace.");
  if (parsed.flags.resume !== undefined) {
    const sources = [
      ...(parsed.flags.persona === undefined ? [] : ["--persona"]),
      ...(env.persona === undefined ? [] : ["ELWOOD_PERSONA"]),
    ];
    if (sources.length > 0) throw usage(settingConflict(sources, "--resume"));
  }
}

export function validateOutput(
  output: CliOutputMode,
  stream: SourcedValue<boolean>,
  verbose: SourcedValue<boolean>,
  debug: boolean,
  head: boolean,
): void {
  if (stream.value === true && output !== "text") {
    throw usage(
      `Streaming is enabled by ${stream.source}; ${outputName(output)} output requires streaming to be disabled. Use --no-stream.`,
    );
  }
  if (!head) return;
  if (stream.value === true)
    throw usage(`Streaming is enabled by ${stream.source}; --head requires --no-stream.`);
  if (verbose.value === true)
    throw usage(`Verbose progress is enabled by ${verbose.source}; --head requires --no-verbose.`);
  if (debug) throw usage("--head cannot be combined with --debug.");
  if (output === "jsonl") throw usage("--head cannot be combined with JSONL output.");
}

function outputName(output: Exclude<CliOutputMode, "text">): string {
  return output === "json" ? "JSON" : "JSONL";
}

/** Describe incompatible invocation settings and the exact way to remove each source. */
export function settingConflict(sources: readonly string[], target: string): string {
  const flags = sources.filter((source) => source.startsWith("--"));
  const inherited = sources.filter((source) => source.startsWith("ELWOOD_"));
  const subject = sources.join(" and ");
  const recovery = [
    ...(flags.length === 0 ? [] : [`Remove ${flags.join(" and ")}.`]),
    ...(inherited.length === 0 ? [] : [`Use --no-defaults to ignore ${inherited.join(" and ")}.`]),
  ].join(" ");
  return `${subject} ${sources.length === 1 ? "is" : "are"} incompatible with ${target}. ${recovery}`;
}

function adapterConflictSources(
  parsed: ParsedRunCommand,
  env: EnvSettings,
  agent: CliAgent,
): readonly string[] {
  if (agent === "codex")
    return [
      ...(parsed.flags.claudePermissionMode === undefined ? [] : ["--claude-permission-mode"]),
      ...(env.claudePermissionMode === undefined ? [] : ["ELWOOD_CLAUDE_PERMISSION_MODE"]),
    ];
  return [
    ...(parsed.flags.codexSandbox === undefined ? [] : ["--codex-sandbox"]),
    ...(parsed.flags.codexApprovalPolicy === undefined ? [] : ["--codex-approval-policy"]),
    ...(env.codexSandbox === undefined ? [] : ["ELWOOD_CODEX_SANDBOX"]),
    ...(env.codexApprovalPolicy === undefined ? [] : ["ELWOOD_CODEX_APPROVAL_POLICY"]),
  ];
}
