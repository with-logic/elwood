/**
 * Builds the launch arguments and shell commands used to start interactive Codex.
 * The argument list is shared by the headless PTY launch and `elwood interactive`
 * (§12A.9), so the Elwood-to-Codex flag mapping cannot drift between them.
 * Implements PRD §4.2, §4.4, §9.1, and §12A.9.
 */

import { hookCommand } from "../runtime/hook-command.ts";
import { type LaunchArgument, launchShellWords } from "../runtime/launch-arguments.ts";
import { shellQuote } from "../runtime/shell.ts";
import type { SessionRecord } from "../state/store.ts";
import { codexHookEventNames } from "./hooks/index.ts";
import type { CodexCliCapabilities } from "./preflight.ts";
import type { StartCodexOptions } from "./session/types.ts";

/** The subset of start options that become Codex's own command-line flags. */
export type CodexLaunchArgumentOptions = Pick<
  StartCodexOptions,
  "model" | "profile" | "sandbox" | "approvalPolicy"
> & {
  readonly cwd: string;
  readonly resumeId?: string;
};

/** Codex's native arguments for a launch, in stable order (no hook wiring). */
export function codexLaunchArguments(
  options: CodexLaunchArgumentOptions,
): readonly LaunchArgument[] {
  const parts: LaunchArgument[] = options.resumeId ? [["resume", options.resumeId]] : [];
  if (options.model) parts.push(["--model", options.model]);
  if (options.profile) parts.push(["--profile", options.profile]);
  if (options.sandbox) parts.push(["--sandbox", options.sandbox]);
  if (options.approvalPolicy) parts.push(["--ask-for-approval", options.approvalPolicy]);
  parts.push(["--cd", options.cwd]);
  return parts;
}

/**
 * Codex's reasoning-effort override as a `-c` argument. Validated before spawn
 * (C-CODEX-21) and emitted as a bare TOML string value; the enum members contain
 * no TOML-special characters.
 */
export function codexEffortArguments(
  reasoningEffort: string | undefined,
): readonly LaunchArgument[] {
  if (!reasoningEffort) return [];
  return [["-c", `model_reasoning_effort="${reasoningEffort}"`]];
}

export function buildCodexShellCommand(
  record: SessionRecord,
  bridgeScriptPath: string,
  options: StartCodexOptions,
  capabilities: CodexCliCapabilities = { supportsHookTrustBypass: true },
): string {
  const parts = ["exec", "codex"];
  const launch = codexLaunchArguments({
    ...options,
    cwd: record.cwd,
    ...(record.codex.resumeId === undefined ? {} : { resumeId: record.codex.resumeId }),
  });
  parts.push(...launchShellWords(launch));
  if (capabilities.supportsHookTrustBypass) {
    parts.push("--dangerously-bypass-hook-trust");
  }
  // Elwood's `hooks.*` overrides precede the caller's `configOverrides` by design: a
  // caller may override (or disable) the bridge hooks, which PRD §4.4 permits.
  for (const override of hookOverrides(bridgeScriptPath, options))
    parts.push("-c", shellQuote(override));
  for (const override of options.configOverrides ?? []) parts.push("-c", shellQuote(override));
  // Reasoning effort is applied AFTER caller overrides so it wins over a hand-rolled
  // `model_reasoning_effort` duplicate.
  parts.push(...launchShellWords(codexEffortArguments(options.reasoningEffort)));
  parts.push("-c", shellQuote("features.hooks=true"));
  parts.push("-c", shellQuote('hookTrust="trust-all"'));
  return parts.join(" ");
}

/**
 * Seconds of slack added to the CLI-side hook timeout beyond Elwood's fail-open
 * deadline. Codex starts its clock when it SPAWNS the hook, before the bridge has
 * connected and Elwood's own timer has started, so an identical value would let
 * Codex kill the hook just before Elwood's fail-open no-decision response arrives.
 */
const cliHookTimeoutSlackSeconds = 5;

function hookOverrides(bridgeScriptPath: string, options: StartCodexOptions): string[] {
  const timeout = Math.ceil((options.hookTimeoutMs ?? 25_000) / 1000) + cliHookTimeoutSlackSeconds;
  return codexHookEventNames.map((eventName) => {
    const command = hookCommand(bridgeScriptPath);
    const hook = `{type="command",command=${tomlString(command)},timeout=${timeout}}`;
    const group = `{matcher=${tomlString(matcherFor(eventName))},hooks=[${hook}]}`;
    return `hooks.${eventName}=[${group}]`;
  });
}

function matcherFor(eventName: string): string {
  if (eventName === "UserPromptSubmit" || eventName === "Stop") return "";
  if (eventName === "SessionStart") return "startup|resume|clear|compact";
  if (eventName === "PreCompact" || eventName === "PostCompact") return "manual|auto";
  return "*";
}

function tomlString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
