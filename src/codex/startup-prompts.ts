/**
 * Handles known Codex startup prompts that block interactive sessions.
 * Implements PRD §4.4, §5.5, and §5.7.
 */

import type { SettledStartupOutcome } from "../core/startup-write.ts";
import { numberedOptions } from "../core/terminal-options.ts";
import { TrustPromptResponder, type TrustWriteResult } from "../core/trust-responder.ts";
import type { ElwoodWarningEvent } from "../core/types.ts";

/** A Codex startup outcome paired with its PTY-write completion (§5.4, §5.7). */
export type SettledCodexStartupOutcome = SettledStartupOutcome<"codex">;

export type CodexStartupPromptResult = {
  readonly warnings: readonly ElwoodWarningEvent[];
  readonly outcomes: readonly SettledCodexStartupOutcome[];
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

  handle(screenText: string, write: (input: string) => TrustWriteResult): CodexStartupPromptResult {
    const outcomes: SettledCodexStartupOutcome[] = [];
    this.buffer = `${this.buffer}\n${screenText}`.slice(-maxBufferLength);
    // Trust prompts are matched against the CURRENT frame only: a stale phrase in
    // the accumulated buffer must never pair with a different dialog's answer.
    const trust = this.trust.handle(screenText, write);
    if (trust?.kind === "answered") {
      outcomes.push({ outcome: { kind: "answered", ...trust.automation }, settled: trust.settled });
    } else if (trust?.kind === "option_pending") {
      outcomes.push({ outcome: { kind: "option_pending", prompt: trust.prompt } });
    }
    // Skipping an available update is not a trust decision, so it stays here.
    if (!this.skippedUpdate && /update/i.test(this.buffer)) {
      const option = findNumberedOption(this.buffer, updateOptionPattern);
      if (option) {
        // Settle OPTIMISTICALLY but keep the skip retryable if the write is
        // rejected, so a later frame re-attempts it rather than falsely reporting
        // the update as skipped (C-CODEX-17).
        this.skippedUpdate = true;
        const settled = Promise.resolve(write(option)).catch((error: unknown) => {
          this.skippedUpdate = false;
          throw error;
        });
        outcomes.push({ outcome: { kind: "answered", prompt: "update", input: option }, settled });
      }
    }
    return { warnings: codexWarningsFromText(this.buffer, this.elwoodSessionId), outcomes };
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
