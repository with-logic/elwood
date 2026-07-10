/**
 * Handles known Codex startup prompts that block interactive sessions.
 * Implements PRD §4.4, §5.5, and §5.7.
 */

import type { TrustPromptIdFor } from "../core/trust-prompts.ts";
import { TrustPromptResponder } from "../core/trust-responder.ts";
import type { ElwoodWarningEvent } from "../core/types.ts";

export type CodexStartupPromptAutomation = {
  /** A Codex trust-prompt label (Claude-only ids are excluded) or `update`. */
  readonly prompt: TrustPromptIdFor<"codex"> | "update";
  readonly input: string;
  /** True when a recognized trust prompt could not be answered (see startup-automation). */
  readonly unanswerable?: boolean;
};

export type CodexStartupPromptResult = {
  readonly warnings: readonly ElwoodWarningEvent[];
  readonly automations: readonly CodexStartupPromptAutomation[];
};

const maxBufferLength = 6_000;
const updateOptionPattern = /continue\s*without\s*updat|skip|not\s*now|later/i;

export class CodexStartupPromptResponder {
  private buffer: string;
  private readonly elwoodSessionId: string;
  private readonly trust: TrustPromptResponder<"codex">;
  private skippedUpdate: boolean;

  constructor(elwoodSessionId = "", autotrust = false) {
    this.elwoodSessionId = elwoodSessionId;
    this.buffer = "";
    // Owns the whole allowlisted trust family (directory + hook trust), not just
    // one prompt; extended by adding entries to trustPromptAllowlist.
    this.trust = new TrustPromptResponder("codex", autotrust);
    this.skippedUpdate = false;
  }

  handle(screenText: string, write: (input: string) => void): CodexStartupPromptResult {
    const automations: CodexStartupPromptAutomation[] = [];
    this.buffer = `${this.buffer}\n${screenText}`.slice(-maxBufferLength);
    // Trust prompts are matched against the CURRENT frame only: a stale phrase in
    // the accumulated buffer must never pair with a different dialog's answer.
    const trust = this.trust.handle(screenText, write);
    if (trust?.kind === "answered") automations.push(trust.automation);
    else if (trust?.kind === "unanswerable") {
      automations.push({ prompt: trust.prompt, input: "", unanswerable: true });
    }
    // Skipping an available update is not a trust decision, so it stays here.
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
