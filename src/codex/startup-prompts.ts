/**
 * Handles known Codex startup prompts that block interactive sessions.
 * Implements PRD §4.4, §5.5, and §5.7.
 */

import type { ElwoodWarningEvent } from "../core/types.ts";
import { WorkspaceTrustResponder } from "../core/workspace-trust.ts";

export type CodexStartupPromptAutomation = {
  readonly prompt: "hook_trust" | "update" | "workspace_trust";
  readonly input: string;
};

export type CodexStartupPromptResult = {
  readonly warnings: readonly ElwoodWarningEvent[];
  readonly automations: readonly CodexStartupPromptAutomation[];
};

const maxBufferLength = 6_000;
const updateOptionPattern = /continue\s*without\s*updat|skip|not\s*now|later/i;
const hookTrustPattern = /Trust\s*all\s*and\s*continue/i;

export class CodexStartupPromptResponder {
  private buffer: string;
  private readonly elwoodSessionId: string;
  private readonly workspaceTrust: WorkspaceTrustResponder;
  private trustedHooks: boolean;
  private skippedUpdate: boolean;

  constructor(elwoodSessionId = "", autotrust = false) {
    this.elwoodSessionId = elwoodSessionId;
    this.buffer = "";
    this.workspaceTrust = new WorkspaceTrustResponder("codex", autotrust);
    this.trustedHooks = false;
    this.skippedUpdate = false;
  }

  handle(screenText: string, write: (input: string) => void): CodexStartupPromptResult {
    const automations: CodexStartupPromptAutomation[] = [];
    this.buffer = `${this.buffer}\n${screenText}`.slice(-maxBufferLength);
    const trust = this.workspaceTrust.handle(this.buffer, write);
    if (trust) automations.push(trust);
    if (!this.trustedHooks && /Hooks need review/i.test(this.buffer)) {
      const option = findNumberedOption(this.buffer, hookTrustPattern);
      if (option) {
        write(option);
        automations.push({ prompt: "hook_trust", input: option });
        this.trustedHooks = true;
      }
    }
    if (!this.skippedUpdate && /update/i.test(this.buffer)) {
      const option = findNumberedOption(this.buffer, updateOptionPattern);
      if (option) {
        write(option);
        automations.push({ prompt: "update", input: option });
        this.skippedUpdate = true;
      }
    }
    return { warnings: codexWarningsFromText(this.buffer, this.elwoodSessionId), automations };
  }
}

export function findNumberedOption(text: string, pattern: RegExp): string | null {
  return numberedOptions(text).find((option) => pattern.test(option.label))?.number ?? null;
}

export function codexWarningsFromText(
  text: string,
  elwoodSessionId: string,
): readonly ElwoodWarningEvent[] {
  const warnings: ElwoodWarningEvent[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const login = /The ([\w.-]+) MCP server is not logged in\. Run `([^`]+)`\./.exec(line);
    if (login) warnings.push(mcpLoginWarning(elwoodSessionId, line, login[1]!, login[2]!));
    const failed = /MCP startup incomplete \(failed:\s*([^)]+)\)/.exec(line);
    if (failed) warnings.push(mcpStartupWarning(elwoodSessionId, line, failed[1]!));
  }
  return warnings;
}

function mcpLoginWarning(
  elwoodSessionId: string,
  raw: string,
  mcpServerName: string,
  recoveryCommand: string,
): ElwoodWarningEvent {
  return {
    elwoodSessionId,
    agent: "codex",
    source: "terminal",
    code: "mcp_server_not_logged_in",
    severity: "warning",
    message: `The ${mcpServerName} MCP server is not logged in.`,
    mcpServerName,
    recoveryCommand,
    raw,
  };
}

function mcpStartupWarning(
  elwoodSessionId: string,
  raw: string,
  failed: string,
): ElwoodWarningEvent {
  const failedServers = failed.split(",").map((server) => server.trim());
  return {
    elwoodSessionId,
    agent: "codex",
    source: "terminal",
    code: "mcp_startup_incomplete",
    severity: "warning",
    message: `MCP startup incomplete: ${failedServers.join(", ")}.`,
    failedServers,
    recoveryCommands: failedServers.map((server) => `codex mcp login ${server}`),
    raw,
  };
}

function numberedOptions(
  text: string,
): readonly { readonly number: string; readonly label: string }[] {
  return text.split("\n").flatMap((line) => {
    const matches = line.matchAll(/(?:^|[\s›>])(\d+)[.)]\s*(.+?)(?=\s*\d+[.)]\s*|$)/g);
    return [...matches].map((match) => ({ number: match[1]!, label: match[2]!.trim() }));
  });
}
