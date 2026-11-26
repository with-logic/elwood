/**
 * Recognized native trust-dialog explanations, excluding arbitrary intervening prose.
 * Implements PRD §5.4/C-TRUST-01/C-CLAUDE-28. Claude copy is captured in trust-responder-cursor,
 * trust-bypass-permissions and claude-mcp-server-prompt tests, the last from
 * `tests/fixtures/claude-2.1.332/trust/`; Codex directory/hooks were captured from 0.154.0.
 * Claude's workspace prompt, whose copy depends on the folder's settings, is in
 * `claude-workspace.ts`.
 *
 * A prompt with known copy REQUIRES an explanatory sentence before any key is
 * written: a bare allowlisted header is a hold-only candidate, never a verified
 * dialog. Only version-variable rows (a count, a link label, a later sentence) stay optional.
 */

/** Skill and plugin gates have no captured explanatory copy; none is accepted. */
export const noTrustDescription = /^$/;

/** The body of Claude's prompt for one new project MCP server, captured from 2.1.332. */
export const claudeMcpDescription =
  /^MCP servers may execute code or access system resources\. All tool calls require approval\. Learn more in the MCP documentation\.$/;

// 2.1.268 shows the first sentence and the acceptance; 2.1.310 adds the sandbox sentence
// between them and the security-guide link below. Only the first sentence is required.
const bypassNoApproval = String.raw`In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous commands\.`;
const bypassSandboxOnly = String.raw`This mode should only be used in a sandboxed container/VM that has restricted internet access and can easily be restored if damaged\.`;
const bypassResponsibility = String.raw`By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode\.`;
const securityGuide = String.raw`https://code\.claude\.com/docs/en/security`;
export const claudeBypassDescription = new RegExp(
  `^${bypassNoApproval}\\s*(?:${bypassSandboxOnly}\\s*)?(?:${bypassResponsibility}\\s*)?(?:${securityGuide})?$`,
);

export const codexWorkspaceDescription =
  /^Working with untrusted contents comes with higher risk of prompt injection\. Trusting the directory allows project-local config, hooks, and exec policies to load\.$/;

export const codexHooksDescription =
  /^(?:\d+ hooks? (?:is|are) new or changed\.\s*)?Hooks can run outside the sandbox after you trust them\.$/;

/** Codex 0.156.1 folder access copy, captured through the native PTY. */
export const codexFolderAccessDescription =
  /^Codex can read, edit, and run files here, subject to your permission settings\. Folder settings can run code automatically, even without a model request\. Continue only if you trust these files\. Your trust decision will be saved\.$/;
