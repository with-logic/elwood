/**
 * Handles known Codex startup prompts that block interactive sessions.
 * Implements PRD §4.4, §5.5, and §5.7.
 */

import type { ElwoodWarningEvent } from "../core/types.ts";

export type CodexStartupPromptAutomation = {
  readonly prompt: "hook_trust" | "update";
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
  private readonly seenWarnings = new Set<string>();
  private trustedHooks: boolean;
  private skippedUpdate: boolean;

  constructor(elwoodSessionId = "") {
    this.elwoodSessionId = elwoodSessionId;
    this.buffer = "";
    this.trustedHooks = false;
    this.skippedUpdate = false;
  }

  handle(screenText: string, write: (input: string) => void): CodexStartupPromptResult {
    const automations: CodexStartupPromptAutomation[] = [];
    this.buffer = `${this.buffer}\n${screenText}`.slice(-maxBufferLength);
    if (!this.trustedHooks && /Hooks need review/i.test(this.buffer)) {
      if (hasNumberedOption(this.buffer, "2", hookTrustPattern)) {
        write("2");
        automations.push({ prompt: "hook_trust", input: "2" });
        this.trustedHooks = true;
      }
    }
    if (!this.skippedUpdate && /update/i.test(this.buffer)) {
      if (hasNumberedOption(this.buffer, "2", updateOptionPattern)) {
        write("2");
        automations.push({ prompt: "update", input: "2" });
        this.skippedUpdate = true;
      }
    }
    return { warnings: this.newWarnings(), automations };
  }

  private newWarnings(): readonly ElwoodWarningEvent[] {
    const warnings: ElwoodWarningEvent[] = [];
    for (const warning of codexWarningsFromText(this.buffer, this.elwoodSessionId)) {
      const key = warningKey(warning);
      if (!this.seenWarnings.has(key)) {
        this.seenWarnings.add(key);
        warnings.push(warning);
      }
    }
    return warnings;
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

function warningKey(warning: ElwoodWarningEvent): string {
  if (warning.code === "version_unparseable") return `${warning.code}:${warning.agent}`;
  if ("mcpServerName" in warning) return `${warning.code}:${warning.mcpServerName}`;
  return `${warning.code}:${warning.failedServers.join(",")}`;
}

function hasNumberedOption(text: string, number: string, pattern: RegExp): boolean {
  return numberedOptions(text).some(
    (option) => option.number === number && pattern.test(option.label),
  );
}

function numberedOptions(
  text: string,
): readonly { readonly number: string; readonly label: string }[] {
  return text.split("\n").flatMap((line) => {
    const matches = line.matchAll(/(?:^|[\s›>])(\d+)[.)]\s*(.+?)(?=\s*\d+[.)]\s*|$)/g);
    return [...matches].map((match) => ({ number: match[1]!, label: match[2]!.trim() }));
  });
}
