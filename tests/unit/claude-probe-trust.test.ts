/**
 * The model probe's trust policy over load rows and other prompts (PRD §5.3, C-CLAUDE-29,
 * C-CLAUDE-30): it refuses each captured load row, with or without the permissions warning, and
 * Claude's MCP server, plugin, and skill prompts with their reasons, still accepts the
 * bypass-permissions disclaimer, and refuses a painted workspace prompt that never verified
 * when its five-second trust budget runs out, but not one that verified or was still painting.
 */
import { afterEach, expect, test, vi } from "vitest";
import { gateBudgetMs } from "../../src/core/trust/deadline.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";
import { probeOutcome, probeResponder, refusedOutcome } from "../helpers/claude-probe-responder.ts";
import {
  claudeLoadRowCaptures,
  claudeMcpServerPrompt,
  claudePermissionsCaptures,
  claudeSettingsEnvPrompt,
  claudeWorkspaceTrustScreen,
} from "../helpers/claude-workspace-trust-screen.ts";

afterEach(() => {
  vi.useRealTimers();
});

const disclosureRefusals = {
  hooks: "hooks_disclosed",
  mcp_servers: "mcp_servers_disclosed",
  settings: "settings_disclosed",
} as const;

const plain = claudeWorkspaceTrustScreen("/tmp/project");
const plainRows = plain.split("\n");
/** The plain prompt read mid-paint: its body cut mid-sentence, its options still on screen or not yet. */
const midPaint = (options: boolean) =>
  [...plainRows.slice(0, 7), ...(options ? plainRows.slice(13) : [])].join("\n");

test.each(
  claudeLoadRowCaptures,
)("C-CLAUDE-29 the probe refuses the captured load row %s", (_, frame, disclosure) => {
  expect(probeOutcome(frame)).toEqual(refusedOutcome(disclosureRefusals[disclosure]));
});

test.each(
  claudePermissionsCaptures,
)("C-CLAUDE-30 the probe refuses the captured permissions warning %s with its load row's reason", (_, frame, disclosure) => {
  expect(probeOutcome(frame)).toEqual(refusedOutcome(disclosureRefusals[disclosure]));
});

const extensionPrompts = [
  ["the MCP server", claudeMcpServerPrompt, "mcp_server_prompt", "mcp_trust"],
  [
    "a plugin",
    "Do you trust the plugin?\n1. Yes, trust it\n2. No",
    "plugin_prompt",
    "plugin_trust",
  ],
  ["a skill", "Load this skill?\n1. Yes, load this skill\n2. No", "skill_prompt", "skill_trust"],
] as const;

test.each(
  extensionPrompts.flatMap(([name, ...prompt]) =>
    [true, false].map((canDisclose) => [name, canDisclose, ...prompt] as const),
  ),
)("C-CLAUDE-29 the probe refuses Claude's prompt for %s (can disclose: %s)", (_, canDisclose, frame, reason, owner) => {
  expect(probeOutcome(frame, canDisclose)).toEqual(refusedOutcome(reason, owner));
});

test.each([
  true,
  false,
])("C-CLAUDE-29 the probe still accepts the bypass-permissions disclaimer (can disclose: %s)", (canDiscloseHooks) => {
  const disclaimer = capturedFrame("claude-2.1.310/bypass-permissions-100");
  expect(probeOutcome(disclaimer, canDiscloseHooks)).toMatchObject({
    outcomes: [{ outcome: { kind: "attempted", prompt: "bypass_permissions" } }],
    refusals: [],
  });
});

test.each([
  true,
  false,
])("C-CLAUDE-29 the probe refuses a workspace prompt still unverified when its budget runs out (can disclose: %s)", (canDiscloseHooks) => {
  vi.useFakeTimers();
  const { responder, show, refusals, writes, stateChanges } = probeResponder(canDiscloseHooks);
  expect(show(claudeSettingsEnvPrompt)).toEqual([]);
  vi.advanceTimersByTime(gateBudgetMs - 1);
  expect(refusals).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(refusals).toEqual(["workspace_unverified"]);
  expect(stateChanges).toHaveBeenCalled();
  expect(responder.blockedPrompt).toBe("workspace_trust");
  expect(writes).toEqual([]);
  responder.dispose();
});

test("C-CLAUDE-29 a refused load row that reaches its budget is not also unverified", () => {
  vi.useFakeTimers();
  const { responder, show, refusals } = probeResponder();
  show(capturedFrame("claude-2.1.332/trust/workspace-settings-120"));
  vi.advanceTimersByTime(gateBudgetMs);
  expect(responder.blockedPrompt).toBe("workspace_trust");
  expect(refusals).toEqual(["settings_disclosed"]);
  responder.dispose();
});

test("C-CLAUDE-29 an unverified workspace prompt replaced by a verified one before its budget runs out is not refused", () => {
  vi.useFakeTimers();
  const { responder, show, refusals } = probeResponder();
  show(claudeSettingsEnvPrompt);
  show(plain);
  vi.advanceTimersByTime(gateBudgetMs);
  expect(refusals).toEqual([]);
  responder.dispose();
});

test("C-CLAUDE-29 a verified workspace prompt read mid-paint as its budget runs out is not refused", () => {
  vi.useFakeTimers();
  const { responder, show, refusals } = probeResponder();
  show(plain);
  // Unverified with its options on screen, but the prompt verified before.
  show(midPaint(true));
  vi.advanceTimersByTime(gateBudgetMs);
  expect(responder.blockedPrompt).toBe("workspace_trust");
  expect(refusals).toEqual([]);
  responder.dispose();
});

test("C-CLAUDE-29 a workspace prompt whose options have not painted when its budget runs out is answered once they paint", () => {
  vi.useFakeTimers();
  const { responder, show, refusals } = probeResponder();
  expect(show(midPaint(false))).toEqual([]);
  vi.advanceTimersByTime(gateBudgetMs);
  expect(responder.blockedPrompt).toBe("workspace_trust");
  expect(show(plain)).toMatchObject([
    { outcome: { kind: "attempted", prompt: "workspace_trust" } },
  ]);
  expect(refusals).toEqual([]);
  responder.dispose();
});
