/**
 * Builds shell commands used to launch interactive Codex.
 * Implements PRD §4.2, §4.4, and §9.1.
 */

import type { SessionRecord } from "../state/store.ts";
import { codexHookEventNames } from "./hooks.ts";
import type { CodexCliCapabilities } from "./preflight.ts";
import type { StartCodexOptions } from "./session-types.ts";

export function buildCodexShellCommand(
  record: SessionRecord,
  options: StartCodexOptions,
  capabilities: CodexCliCapabilities = { supportsHookTrustBypass: true },
): string {
  const parts = ["exec", "codex"];
  addLaunchFlags(parts, options);
  parts.push("--cd", shellQuote(options.cwd));
  if (capabilities.supportsHookTrustBypass) {
    parts.push("--dangerously-bypass-hook-trust");
  }
  parts.push("-c", shellQuote("features.hooks=true"));
  for (const override of hookOverrides(record, options)) parts.push("-c", shellQuote(override));
  for (const override of options.configOverrides ?? []) parts.push("-c", shellQuote(override));
  parts.push("-c", shellQuote('hookTrust="trust-all"'));
  if (record.codex.resumeId) parts.push("resume", shellQuote(record.codex.resumeId));
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

function hookOverrides(record: SessionRecord, options: StartCodexOptions): string[] {
  const timeout = Math.ceil((options.hookTimeoutMs ?? 25_000) / 1000);
  return codexHookEventNames.map((eventName) => {
    const command = `${process.execPath} ${record.paths.bridgeScriptPath}`;
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
