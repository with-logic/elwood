/**
 * Recognized native trust-dialog explanations, excluding arbitrary intervening prose.
 * Implements PRD §5.4/C-TRUST-01. Claude copy is captured in trust-responder-cursor
 * and trust-bypass-permissions tests; Codex directory/hooks were captured from 0.154.0.
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
export const claudeWorkspaceDescription = new RegExp(
  `^(?:${likeYourOwn}\\s*(?:${ableTo}\\s*)?|${ableTo}\\s*)(?:Security guide)?$`,
);

export const claudeBypassDescription =
  /^In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous commands\.\s*(?:By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode\.)?$/;

export const codexWorkspaceDescription =
  /^Working with untrusted contents comes with higher risk of prompt injection\. Trusting the directory allows project-local config, hooks, and exec policies to load\.$/;

export const codexHooksDescription =
  /^(?:\d+ hooks? (?:is|are) new or changed\.\s*)?Hooks can run outside the sandbox after you trust them\.$/;
