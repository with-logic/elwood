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
const isolated = ["-p", "--output-format", "stream-json", "--verbose",
              "--no-session-persistence", "--strict-mcp-config", "--setting-sources", "user",
              "--settings", '{"disableAllHooks":true}', "--tools", ""];
const args = [...isolated, "--input-format", "stream-json"];
const initial = { type: "control_request", request_id: "usage", request: { subtype: "get_usage", skip_behaviors: true } };
// Only retry an ordinary native sign-in. Provider-prefixed overrides can select
// another credential source or make a one-time credential available to one child.
function standardFallbackEnvironment() {
  const profile = new Set(["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"]);
  return process.cwd() === "/" &&
    Object.keys(process.env).every(key => !/^(?:CLAUDE_|ANTHROPIC_|CLAUDECODE$)/.test(key) || profile.has(key));
}
function receive(message) {
  if (message?.type !== "control_response" || message.response?.request_id !== "usage") return undefined;
  if (message.response.subtype === "success") return message.response.response ?? null;
  const error = message.response.error;
  const isUnsupportedUsageResponse = message.response.subtype === "error" &&
    (error === "Unsupported control request subtype: get_usage" || error === "Unsupported control request subtype");
  if (isUnsupportedUsageResponse && standardFallbackEnvironment()) {
    return () => relayFallback([...isolated, "--safe-mode", "/usage"]);
  }
  return null;
}
`,
} as const;
