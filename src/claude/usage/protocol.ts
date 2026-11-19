/** Claude Code stream-json quota request for the supervised client (PRD §5.12). */
export const claudeUsageProtocol = {
  variable: "CLAUDE_CONFIG_DIR",
  protocol: `
if (profileDir !== undefined) {
  if (process.env.CLAUDE_CONFIG_DIR !== profileDir) process.exit(1);
  // The native CLI must resolve this profile's sign-in after the login shell runs.
  for (const key of ["CLAUDE_SECURESTORAGE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
                     "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]) delete process.env[key];
}
const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
              "--no-session-persistence", "--strict-mcp-config", "--setting-sources", "user",
              "--settings", '{"disableAllHooks":true}', "--tools", ""];
const initial = { type: "control_request", request_id: "usage", request: { subtype: "get_usage", skip_behaviors: true } };
function receive(message) {
  if (message?.type !== "control_response" || message.response?.request_id !== "usage") return undefined;
  return message.response.subtype === "success" ? message.response.response ?? null : null;
}
`,
} as const;
