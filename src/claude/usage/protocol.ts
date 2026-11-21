/** Claude Code stream-json quota request for the supervised client (PRD §5.12). */
import { unverifiedSettingsMarker } from "./diagnostics.ts";

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
const usageRequest = { type: "control_request", request_id: "usage", request: { subtype: "get_usage", skip_behaviors: true } };
// Print mode prefers an exported API key. Claude can load gateway routing
// from settings, so check the effective settings before removing the key.
let awaitingSettings = Boolean(process.env.ANTHROPIC_API_KEY && isDefaultEndpoint(process.env.ANTHROPIC_BASE_URL));
let settingsPermitFallback = true;
const initial = awaitingSettings
  ? { type: "control_request", request_id: "settings", request: { subtype: "get_settings" } }
  : usageRequest;
function isDefaultEndpoint(url) {
  return url === undefined || url === "" || url === "https://api.anthropic.com" || url === "https://api.anthropic.com/";
}
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function settingsCredentialPolicy(response) {
  const effective = response.subtype === "success" && response.response?.effective;
  if (!isRecord(effective) || (effective.env !== undefined && !isRecord(effective.env))) return undefined;
  const env = effective.env ?? {};
  const routing = [env.ANTHROPIC_BASE_URL, env.ANTHROPIC_API_KEY, effective.forceLoginGatewayUrl, effective.apiKeyHelper];
  if (routing.some(value => value !== undefined && typeof value !== "string")) return undefined;
  return {
    removeKey: isDefaultEndpoint(env.ANTHROPIC_BASE_URL) &&
      !env.ANTHROPIC_API_KEY && !effective.forceLoginGatewayUrl && !effective.apiKeyHelper,
    allowFallback: standardCredentialEnvironment(env)
  };
}
// Only retry an ordinary native sign-in. Provider-prefixed overrides can select
// another credential source or make a one-time credential available to one child.
function standardCredentialEnvironment(env) {
  const profile = new Set(["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"]);
  return Object.keys(env).every(key => !/^(?:CLAUDE_|ANTHROPIC_|CLAUDECODE$)/.test(key) || profile.has(key));
}
function receive(message, send, restart) {
  if (message?.type !== "control_response") return undefined;
  const response = message.response;
  if (awaitingSettings) {
    if (response?.request_id !== "settings") return undefined;
    awaitingSettings = false;
    // Keep settings and any values they contain inside this subprocess.
    const policy = settingsCredentialPolicy(response);
    if (policy?.removeKey) return () => {
      settingsPermitFallback = policy.allowFallback;
      delete process.env.ANTHROPIC_API_KEY;
      restart(usageRequest);
    };
    if (policy === undefined) process.stderr.write(${JSON.stringify(`${unverifiedSettingsMarker}\n`)});
    send(usageRequest);
    return undefined;
  }
  if (response?.request_id !== "usage") return undefined;
  if (response.subtype === "success") return response.response ?? null;
  const error = response.error;
  const isUnsupportedUsageResponse = response.subtype === "error" &&
    (error === "Unsupported control request subtype: get_usage" || error === "Unsupported control request subtype");
  if (isUnsupportedUsageResponse && settingsPermitFallback && process.cwd() === "/" &&
      standardCredentialEnvironment(process.env)) {
    return () => relayFallback([...isolated, "--safe-mode", "/usage"]);
  }
  return null;
}
`,
} as const;
