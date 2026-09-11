/**
 * Closed dotted-key vocabulary for version-1 global CLI configuration.
 * Implements PRD §12A.4 and C-CLI-13/C-CLI-14.
 */

export const configKeys = [
  "schemaVersion",
  "agent",
  "output",
  "timeout",
  "trust",
  "highTrust",
  "stateDir",
  "verbose",
  "stream",
  "persona",
  "claude.model",
  "claude.reasoningEffort",
  "claude.permissionMode",
  "codex.model",
  "codex.reasoningEffort",
  "codex.sandbox",
  "codex.approvalPolicy",
] as const;

export type ConfigKey = (typeof configKeys)[number];
