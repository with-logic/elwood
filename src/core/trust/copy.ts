/**
 * Recognized native trust-dialog explanations, excluding arbitrary intervening prose.
 * Implements PRD §5.4/C-TRUST-01/C-CLAUDE-26. Claude copy is captured in
 * trust-responder-cursor, trust-bypass-permissions and claude-workspace-trust-hooks tests; Codex
 * directory/hooks were captured from 0.154.0.
 *
 * A prompt with known copy REQUIRES an explanatory sentence before any key is
 * written: a bare allowlisted header is a hold-only candidate, never a verified
 * dialog. Only version-variable rows (a count, a link label, a later sentence)
 * stay optional.
 */

/** Skill/plugin/MCP gates have no captured explanatory copy; none is accepted. */
export const noTrustDescription = /^$/;

// Whole sentences only, so a half-painted body never validates. Either sentence
// proves the native body; 2.1.206 omits ", or work from your team".
const likeYourOwn = String.raw`\(Like your own code, a well-known open source project(?:, or work from your team)?\)\. If not, take a moment to review what's in this folder first\.`;
const ableTo = String.raw`Claude Code'll be able to read, edit, and execute files here\.`;
// 2.1.332 adds this pair after `ableTo` when the folder's `.claude/settings.json` declares
// hooks. Only the pair, in order, counts: either row alone is unknown prose and fails closed.
const hooksWarning = String.raw`⚠ This folder configures hooks that can run commands without asking, declared in \.claude/settings\.json`;
const settingsLoad = String.raw`Trusting this folder loads \.claude/settings\.json \(runs commands\)\.`;
const hooksRows = `${hooksWarning}\\s*${settingsLoad}`;
const ableToRows = `${ableTo}\\s*(?:${hooksRows}\\s*)?`;
export const claudeWorkspaceDescription = new RegExp(
  `^(?:${likeYourOwn}\\s*(?:${ableToRows})?|${ableToRows})(?:Security guide)?$`,
);
const hooksRowsPattern = new RegExp(hooksRows);

/** Whether verified Claude workspace copy says the folder declares hooks that trusting runs. */
export function claudeWorkspaceDeclaresHooks(copy: string): boolean {
  return hooksRowsPattern.test(copy);
}

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
