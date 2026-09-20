/** Attention clearance reuses native predicates and keeps explain facts consistent (C-ATTN-02). */
import { expect, test } from "vitest";
import {
  claudeScreenFactTableForTrustPolicy,
  claudeTrustClearance,
} from "../../src/claude/screen-table.ts";
import { readScreenFacts } from "../../src/core/screen-facts.ts";
import { createAttentionClearance } from "../../src/runtime/session/attention-clearance.ts";
import { claudeComposer } from "../fixtures/trust-composer.ts";

const table = claudeScreenFactTableForTrustPolicy(true);
const approval = "Do you want to create file?\n❯ 1. Yes\n  3. No\nEsc to cancel";
function harness() {
  const classify = createAttentionClearance(claudeTrustClearance);
  return (text: string, automation = false) =>
    classify(readScreenFacts(table, { text, title: "" }), text, automation);
}

test("C-ATTN-02 ordinary cold composer evidence remains unchanged", () => {
  expect(harness()("❯ ").facts.composer_visible).toBe(true);
});

test("C-ATTN-02 partial and working frames retain idle verification without false composer matches", () => {
  const read = harness();
  read(approval);
  expect(read("").facts.composer_visible).toBe(false);
  const partial = read("❯ ");
  expect(partial.facts.composer_visible).toBe(false);
  expect(partial.matched.some((match) => match.fact === "composer_visible")).toBe(false);
  const working = read("❯ \nesc to interrupt");
  expect(working.facts.working_visible).toBe(true);
  expect(working.facts.composer_visible).toBe(false);
  expect(read(claudeComposer).facts.composer_visible).toBe(true);
  expect(read("❯ ").facts.composer_visible).toBe(true);
});

test("C-ATTN-02 verified idle during automation preserves the hold until automation releases", () => {
  const read = harness();
  expect(read(claudeComposer, true).facts.composer_visible).toBe(true);
  expect(read("❯ ").facts.composer_visible).toBe(false);
  expect(read(claudeComposer).facts.composer_visible).toBe(true);
  expect(read("❯ ").facts.composer_visible).toBe(true);
});
