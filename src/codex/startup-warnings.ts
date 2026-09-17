/**
 * Parses native Codex MCP warnings only inside a visible startup welcome region.
 * Implements PRD §5.7 / C-API-14: markerless transcript continuations are not diagnostics.
 */
import type { ElwoodWarningEvent } from "../core/types.ts";

export type CodexBannerWarning = Extract<
  ElwoodWarningEvent,
  { readonly code: "mcp_server_not_logged_in" | "mcp_startup_incomplete" }
>;

export function codexWarningsFromText(
  text: string,
  elwoodSessionId: string,
): readonly CodexBannerWarning[] {
  const warnings: CodexBannerWarning[] = [];
  for (const raw of nativeWarningRows(text)) {
    const banner = /^\s*⚠\uFE0F?\s+(.+?)\s*$/.exec(raw);
    if (banner === null) continue;
    const line = banner[1]!;
    const login = /^The ([\w.-]+) MCP server is not logged in\. Run `(codex mcp login \1)`\.$/.exec(
      line,
    );
    if (login) warnings.push(mcpLoginWarning(elwoodSessionId, login[1]!, login[2]!));
    const failed = /^MCP startup incomplete \(failed:\s*([\w.-]+(?:,\s*[\w.-]+)*)\)$/.exec(line);
    if (failed) warnings.push(mcpStartupWarning(elwoodSessionId, failed[1]!));
  }
  return warnings;
}

/** Only rows below the native welcome and before any conversation/composer boundary. */
function* nativeWarningRows(text: string): Generator<string> {
  let header = false;
  let body = false;
  for (const raw of text.split(/\r?\n/)) {
    // Keep row provenance: a conversation boundary before the warning invalidates
    // its authority even if a later line copies the native welcome or warning.
    if (/^\s*[›❯●•>]/.test(raw)) break;
    if (/^\s*│\s*>_ OpenAI Codex \(v[\d.]+\)/.test(raw)) header = true;
    if (!body) {
      if (header && /^\s*╰─+╯\s*$/.test(raw)) body = true;
      else if (header && !/^\s*│/.test(raw)) break;
      continue;
    }
    yield raw;
  }
}

function mcpLoginWarning(
  elwoodSessionId: string,
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
    raw: `The ${mcpServerName} MCP server is not logged in. Run \`${recoveryCommand}\`.`,
  };
}

function mcpStartupWarning(elwoodSessionId: string, failed: string): CodexBannerWarning {
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
    raw: `MCP startup incomplete (failed: ${failedServers.join(", ")})`,
  };
}
