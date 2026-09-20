/** Update replacement holds and diagnostic precedence (PRD §5.5, C-CODEX-12). */
import { expect, test } from "vitest";
import { liveCodexClearance } from "../../src/codex/screen/live-clearance.ts";
import { codexScreenFactTableForTrustPolicy } from "../../src/codex/screen-table.ts";
import { readScreenFacts } from "../../src/core/screen-facts.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";
import { codexSmallComposer, codexTrust, codexTty } from "../fixtures/trust-composer.ts";

const update = "Update available! 0.151.0 -> 0.152.0\n1. Update now\n2. Skip";
const unknown = "Confirm archive removal?\n❯ Proceed\n  Cancel";
const frame = (text: string) => ({ text, title: "" });

test("C-CODEX-12 a replaced update retains input through unknown and partial frames", () => {
  const table = codexScreenFactTableForTrustPolicy(false);
  const read = (text: string) => readScreenFacts(table, frame(text));
  expect(read(update).matched.map(({ id }) => id)).toContain("codex-update-prompt");
  for (const replacement of [unknown, "", "›", "Confirm archive removal?"]) {
    const facts = read(replacement);
    expect(facts.facts.blocking_prompt_visible).toBe(true);
    expect(
      facts.matched.filter(({ fact }) => fact === "blocking_prompt_visible").map(({ id }) => id),
    ).toEqual(["codex-unidentified-dialog"]);
  }
  expect(
    read(`1. Earlier transcript step\n${codexSmallComposer}`).facts.blocking_prompt_visible,
  ).toBe(false);
  expect(read(unknown).facts.blocking_prompt_visible).toBe(false);
});

test("C-CODEX-12 an unknown dialog cannot start a retained update hold", () => {
  const table = codexScreenFactTableForTrustPolicy(false);
  expect(readScreenFacts(table, frame(unknown)).facts.blocking_prompt_visible).toBe(false);
});

test("C-ATTN-03 a retained update hold preserves a specific trust rule", () => {
  const table = codexScreenFactTableForTrustPolicy(false);
  readScreenFacts(table, frame(update));
  const reading = readScreenFacts(table, frame(`${codexTrust}\n1. Yes, continue\n2. No, quit`));
  const rules = reading.matched
    .filter(({ fact }) => fact === "blocking_prompt_visible")
    .map(({ id }) => id);
  expect(rules).toContain("codex-workspace_trust-prompt");
  expect(rules).not.toContain("codex-unidentified-dialog");
});

test("C-CODEX-12 a retained hold requires the live native cursor and completed render", async () => {
  const terminal = createHeadlessTerminal({ cols: 100, rows: 30 }, () => undefined);
  const table = codexScreenFactTableForTrustPolicy(
    false,
    liveCodexClearance(() => terminal),
  );
  const read = () =>
    readScreenFacts(table, { text: terminal.snapshot().text, title: terminal.title }).facts
      .blocking_prompt_visible;
  const paint = `\u001b[2J\u001b[H${codexTty(codexSmallComposer)}`;
  try {
    await terminal.writeOutput(update.replaceAll("\n", "\r\n"));
    expect(read()).toBe(true);
    await terminal.writeOutput(`${paint}\u001b[?25l`);
    expect(read()).toBe(true);
    await terminal.writeOutput(`${paint}\u001b[?2026h`);
    expect(read()).toBe(true);
    await terminal.writeOutput("\u001b[?2026l\u001b]0;⠋ Working\u0007");
    expect(read()).toBe(true);
    await terminal.writeOutput(`\u001b]0;idle\u0007${paint}`);
    const pending = terminal.writeOutput("\u001b[?25l");
    expect(read()).toBe(true);
    await pending;
    expect(read()).toBe(true);
    await terminal.writeOutput(paint);
    expect(read()).toBe(false);
  } finally {
    terminal.dispose();
  }
});
