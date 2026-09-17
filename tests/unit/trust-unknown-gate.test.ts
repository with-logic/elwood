/** Off-allowlist native gates are hold-only blocking facts; lookalikes stay untouched (C-TRUST-01). */
import { describe, expect, test } from "vitest";
import { claudeScreenFactTableForTrustPolicy } from "../../src/claude/screen-table.ts";
import { codexScreenFactTableForTrustPolicy } from "../../src/codex/screen-table.ts";
import { readScreenFacts } from "../../src/core/screen-facts.ts";
import { trustView } from "../../src/core/trust/view.ts";
import { claudeComposer, codexComposer } from "../fixtures/trust-composer.ts";
import { rewordedGate } from "../helpers/unknown-gate.ts";

const tables = {
  claude: claudeScreenFactTableForTrustPolicy,
  codex: codexScreenFactTableForTrustPolicy,
};
const matrix = (["claude", "codex"] as const).flatMap((agent) =>
  [true, false].map((autotrust) => [agent, autotrust] as const),
);
const blocking = (agent: "claude" | "codex", autotrust: boolean, text: string) =>
  readScreenFacts(tables[agent](autotrust), { text, title: "" })
    .matched.filter((rule) => rule.fact === "blocking_prompt_visible")
    .map((rule) => rule.id);

const newCursorGate =
  "Is this plugin source one you trust?\n❯ No, exit\n  Yes, run plugins\n\nEnter to confirm · Esc to cancel";

describe.each(matrix)("%s unknown gate (autotrust %s)", (agent, autotrust) => {
  test("C-ATTN-03 reworded and brand-new header-shaped gates hold under one stable rule id", () => {
    for (const gate of [
      rewordedGate,
      newCursorGate,
      `Accessing workspace:\n/tmp/p\n${newCursorGate}`,
    ])
      expect(blocking(agent, autotrust, gate)).toEqual([`${agent}-unknown_gate-prompt`]);
    expect(trustView(rewordedGate, agent)).toEqual({ kind: "unknown" });
  });

  test("C-TRUST-01 conversation content, the native composer, and incomplete shapes never hold", () => {
    const prose = "  Do you want me to:\n  1. Fix it\n  2. Leave it\n\n──────\n❯ \n──────";
    for (const frame of [
      `● The CLI once asked:\n${rewordedGate}`,
      `› what did it ask?\n${rewordedGate}`,
      `${rewordedGate}\n• quoted above`,
      prose,
      "Do you trust this workspace?\n\nReading project settings",
      claudeComposer,
      codexComposer,
    ])
      expect(blocking(agent, autotrust, frame)).toEqual([]);
    const composer = agent === "claude" ? claudeComposer : codexComposer;
    expect(trustView(composer, agent)).toEqual({ kind: "clear" });
  });

  test("C-ATTN-03 an allowlisted header keeps its own owner, even above header-like text", () => {
    const header =
      agent === "claude"
        ? "Do you trust this folder?"
        : "Do you trust the contents of this directory?";
    const known = autotrust ? [] : [`${agent}-workspace_trust-prompt`];
    expect(blocking(agent, autotrust, `${header}\n1. Yes\n2. No`)).toEqual(known);
    expect(blocking(agent, autotrust, `${header}\nDo you also agree?\n1. Yes\n2. No`)).toEqual(
      known,
    );
  });
});

test("C-ATTN-01 dialogs an adapter table already names keep their label", () => {
  const permission = "Do you want to proceed?\n❯ 1. Yes\n  2. No\n\nEsc to cancel";
  const approval =
    "Do you want this? Would you like to run the following command?\n› 1. Yes\n  2. No\n\nPress enter to confirm or esc to cancel";
  for (const autotrust of [true, false]) {
    expect(blocking("claude", autotrust, permission)).toEqual(["claude-permission-dialog"]);
    expect(blocking("codex", autotrust, approval)).toEqual(["codex-approval-dialog"]);
  }
});

test("C-TRUST-01 another adapter's allowlisted wording is still an unknown gate here", () => {
  const claudeFolder = "Do you trust this folder?\n1. Yes\n2. No";
  expect(blocking("codex", true, claudeFolder)).toEqual(["codex-unknown_gate-prompt"]);
});
