/**
 * Each agent's non-trust startup-prompt labels, and nothing else, pass the runtime check
 * (PRD §5.4, C-CLAUDE-11, C-CLAUDE-27, C-CODEX-12).
 */
import { expect, test } from "vitest";
import { isNonTrustStartupLabel } from "../../src/core/startup/automation.ts";

test.each([
  ["claude", "browser_tools", true],
  ["claude", "auto_mode_setup", true],
  ["codex", "update", true],
  ["claude", "update", false],
  ["codex", "browser_tools", false],
  ["codex", "auto_mode_setup", false],
  ["claude", "workspace_trust", false],
  ["codex", "workspace_trust", false],
  ["claude", "", false],
] as const)("C-CLAUDE-27 %s with label %j is a non-trust startup label: %s", (agent, label, expected) => {
  expect(isNonTrustStartupLabel(agent, label)).toBe(expected);
});
