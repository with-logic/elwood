/**
 * Recognized native trust-dialog explanations, excluding arbitrary intervening prose.
 * Implements PRD §5.4/C-TRUST-01. Claude copy is captured in trust-responder-cursor
 * and trust-bypass-permissions tests; Codex directory/hooks were captured from 0.154.0.
 */

export const noTrustDescription = /^$/;

export const claudeWorkspaceDescription =
  /^(?:\(Like your own code, a well-known open source project(?:, or work from your team)?\)\. If not, take a moment to review what's in this folder first\.\s*)?(?:Claude Code'll be able to read, edit, and execute files here\.\s*)?(?:Security guide)?$/;

export const claudeBypassDescription =
  /^(?:In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous commands\.\s*)?(?:By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode\.)?$/;

export const codexWorkspaceDescription =
  /^(?:Working with untrusted contents comes with higher risk of prompt injection\. Trusting the directory allows project-local config, hooks, and exec policies to load\.)?$/;

export const codexHooksDescription =
  /^(?:\d+ hooks? (?:is|are) new or changed\.\s*)?(?:Hooks can run outside the sandbox after you trust them\.)?$/;
