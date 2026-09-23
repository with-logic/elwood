/** Off-allowlist native gates are hold-only blocking facts; lookalikes stay untouched (C-TRUST-01). */
import { describe, expect, test } from "vitest";
import { claudeScreenFactTableForTrustPolicy } from "../../src/claude/screen-table.ts";
import { codexScreenFactTableForTrustPolicy } from "../../src/codex/screen-table.ts";
import { readScreenFacts } from "../../src/core/screen-facts.ts";
import { trustView } from "../../src/core/trust/view.ts";
import { claudeComposer, clearanceFor, codexComposer } from "../fixtures/trust-composer.ts";
import { rewordedGate } from "../helpers/unknown-gate.ts";

const tables = {
  claude: claudeScreenFactTableForTrustPolicy,
  codex: codexScreenFactTableForTrustPolicy,
};
const matrix = (["claude", "codex"] as const).flatMap((agent) =>
  [true, false].map((autotrust) => [agent, autotrust] as const),
);
const blockingRuleIds = (agent: "claude" | "codex", autotrust: boolean, text: string) =>
  readScreenFacts(tables[agent](autotrust), { text, title: "" })
    .matched.filter((rule) => rule.fact === "blocking_prompt_visible")
    .map((rule) => rule.id);

const footer = "Enter to confirm · Esc to cancel";
const newCursorGate = `Is this plugin source one you trust?\n❯ No, exit\n  Yes, run plugins\n\n${footer}`;

describe.each(matrix)("%s unknown gate (autotrust %s)", (agent, autotrust) => {
  test("C-ATTN-03 reworded and brand-new header-shaped gates hold under one stable rule id", () => {
    for (const gate of [
      rewordedGate,
      newCursorGate,
      "Trust this new workspace provider?\n› 1. Continue\n  2. Quit\n\nenter continue · esc quit",
      `Accessing workspace:\n/tmp/p\n${newCursorGate}`,
    ])
      expect(blockingRuleIds(agent, autotrust, gate)).toEqual([`${agent}-unknown_gate-prompt`]);
    expect(trustView(rewordedGate, agent, clearanceFor(agent))).toEqual({ kind: "unknown" });
  });

  test("C-TRUST-01 conversation content, the native composer, and incomplete shapes never hold", () => {
    const prose = "  Do you want me to:\n  1. Fix it\n  2. Leave it\n\n──────\n❯ \n──────";
    for (const frame of [
      `● The CLI once asked:\n${rewordedGate}`,
      `› what did it ask?\n${rewordedGate}`,
      `${rewordedGate}\n• quoted above`,
      prose,
      "Do you trust this workspace?\n\nReading project settings",
      "Do you trust this workspace?\n1. Yes\n2. No", // options painted, native footer not yet
      `Unrecognized migration\n  Do you want to retry\n❯ No, cancel\n\n${footer}`, // header-like OPTION
      // Outside the PRD §5.4 grammar on purpose: other leading words, or another footer.
      `Allow project plugins to run?\n\n> 1. Yes\n  2. No\n\n${footer}`,
      "Do you trust this workspace?\n> 1. Yes\n  2. No\n\nEnter to select · Esc to exit",
      claudeComposer,
      codexComposer,
    ])
      expect(blockingRuleIds(agent, autotrust, frame)).toEqual([]);
    const composer = agent === "claude" ? claudeComposer : codexComposer;
    expect(trustView(composer, agent, clearanceFor(agent))).toEqual({ kind: "clear" });
  });

  test("C-TRUST-01 a header-like CURSOR option label cannot hide the gate above it", () => {
    // The option row itself starts with allowlist-adjacent wording. Header scanning
    // must skip whole cursor-option blocks the way it already skips numbered ones,
    // or the option becomes the bottom-most candidate and demotes the real gate.
    const gate = `Do you want to allow this new sandbox policy?\n\n❯ Yes, allow it\n  Do you want to review it first\n\n${footer}`;
    expect(blockingRuleIds(agent, autotrust, gate)).toEqual([`${agent}-unknown_gate-prompt`]);
  });

  test("C-ATTN-03 an allowlisted header keeps its own owner, even above header-like text", () => {
    const header =
      agent === "claude"
        ? "Do you trust this folder?"
        : "Do you trust the contents of this directory?";
    const known = autotrust ? [] : [`${agent}-workspace_trust-prompt`];
    expect(blockingRuleIds(agent, autotrust, `${header}\n1. Yes\n2. No`)).toEqual(known);
    expect(
      blockingRuleIds(agent, autotrust, `${header}\nDo you also agree?\n1. Yes\n2. No`),
    ).toEqual(known);
  });
});

test("C-ATTN-01 dialogs an adapter table already names keep their label", () => {
  const permission = "Do you want to proceed?\n❯ 1. Yes\n  2. No\n\nEsc to cancel";
  const approval =
    "Do you want this? Would you like to run the following command?\n› 1. Yes\n  2. No\n\nPress enter to confirm or esc to cancel";
  for (const autotrust of [true, false]) {
    expect(blockingRuleIds("claude", autotrust, permission)).toEqual(["claude-permission-dialog"]);
    expect(blockingRuleIds("codex", autotrust, approval)).toEqual(["codex-approval-dialog"]);
    const updateLike = `Do you trust this updater?\n› 1. Update now\n  2. Skip\n\n${footer}`;
    expect(blockingRuleIds("codex", autotrust, updateLike)).toEqual(["codex-update-prompt"]);
  }
});

test("C-TRUST-01 another adapter's allowlisted wording is still an unknown gate here", () => {
  const claudeFolder = `Do you trust this folder?\n1. Yes\n2. No\n${footer}`;
  expect(blockingRuleIds("codex", true, claudeFolder)).toEqual(["codex-unknown_gate-prompt"]);
});
