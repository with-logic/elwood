/**
 * Handles known Codex startup prompts that block interactive sessions.
 * Implements PRD §4.4, §5.5, and §5.7.
 */

import { numberedOptions } from "../core/terminal-options.ts";
import type { TrustPromptIdFor } from "../core/trust-prompts.ts";
import { TrustPromptResponder } from "../core/trust-responder.ts";
import type { ElwoodWarningEvent } from "../core/types.ts";

/** A Codex startup-prompt label: a Codex trust-prompt id (Claude ids excluded) or `update`. */
export type CodexStartupPromptLabel = TrustPromptIdFor<"codex"> | "update";

/**
 * Discriminated so the two outcomes can't be confused: an `answered` prompt
 * always carries the `input` sent; an `unanswerable` prompt (recognized trust
 * prompt with no verified option) never does.
 */
export type CodexStartupPromptAutomation =
  | { readonly kind: "answered"; readonly prompt: CodexStartupPromptLabel; readonly input: string }
  | { readonly kind: "unanswerable"; readonly prompt: CodexStartupPromptLabel };

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
    if (trust?.kind === "answered") {
      automations.push({ kind: "answered", ...trust.automation });
    } else if (trust?.kind === "unanswerable") {
      automations.push({ kind: "unanswerable", prompt: trust.prompt });
    }
    // Skipping an available update is not a trust decision, so it stays here.
    if (!this.skippedUpdate && /update/i.test(this.buffer)) {
      const option = findNumberedOption(this.buffer, updateOptionPattern);
      if (option) {
        write(option);
        automations.push({ kind: "answered", prompt: "update", input: option });
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
