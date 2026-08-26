/**
 * Builds shell commands used to launch interactive Codex.
 * Implements PRD §4.2, §4.4, and §9.1.
 */

import { hookCommand } from "../runtime/hook-command.ts";
import { shellQuote } from "../runtime/shell.ts";
import type { SessionRecord } from "../state/store.ts";
import { codexHookEventNames } from "./hooks.ts";
import type { CodexCliCapabilities } from "./preflight.ts";
import type { StartCodexOptions } from "./session-types.ts";

export function buildCodexShellCommand(
  record: SessionRecord,
  bridgeScriptPath: string,
  options: StartCodexOptions,
  capabilities: CodexCliCapabilities = { supportsHookTrustBypass: true },
): string {
  const parts = record.codex.resumeId
    ? ["exec", "codex", "resume", shellQuote(record.codex.resumeId)]
    : ["exec", "codex"];
  addLaunchFlags(parts, options);
  parts.push("--cd", shellQuote(record.cwd));
  if (capabilities.supportsHookTrustBypass) {
    parts.push("--dangerously-bypass-hook-trust");
  }
  for (const override of hookOverrides(bridgeScriptPath, options))
    parts.push("-c", shellQuote(override));
  for (const override of options.configOverrides ?? []) parts.push("-c", shellQuote(override));
  // Reasoning effort is validated before spawn (C-CODEX-21) and applied AFTER caller
  // overrides so it wins over a hand-rolled `model_reasoning_effort` duplicate. Emitted
  // as a bare TOML string value; the enum members contain no TOML-special characters.
  if (options.reasoningEffort) {
    parts.push("-c", shellQuote(`model_reasoning_effort="${options.reasoningEffort}"`));
  }
  parts.push("-c", shellQuote("features.hooks=true"));
  parts.push("-c", shellQuote('hookTrust="trust-all"'));
  return parts.join(" ");
}

function addLaunchFlags(parts: string[], options: StartCodexOptions): void {
  if (options.model) parts.push("--model", shellQuote(options.model));
  if (options.profile) parts.push("--profile", shellQuote(options.profile));
  if (options.sandbox) parts.push("--sandbox", shellQuote(options.sandbox));
  if (options.approvalPolicy) {
    parts.push("--ask-for-approval", shellQuote(options.approvalPolicy));
  }
}

function hookOverrides(bridgeScriptPath: string, options: StartCodexOptions): string[] {
  const timeout = Math.ceil((options.hookTimeoutMs ?? 25_000) / 1000);
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
