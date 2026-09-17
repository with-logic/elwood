/** Codex MCP warning conversion, extracted from startup handling (PRD §5.7, C-CODEX-09). */
import type { ElwoodWarningEvent } from "../core/types.ts";

/** The two banner warnings the startup responder parses (an exhaustive pair). */
export type CodexBannerWarning = Extract<
  ElwoodWarningEvent,
  { readonly code: "mcp_server_not_logged_in" | "mcp_startup_incomplete" }
>;

export function codexWarningsFromText(
  text: string,
  elwoodSessionId: string,
): readonly CodexBannerWarning[] {
  const warnings: CodexBannerWarning[] = [];
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
): CodexBannerWarning {
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
): CodexBannerWarning {
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
