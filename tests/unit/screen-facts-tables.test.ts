/**
 * Unit tests for the adapter screen-fact tables (composer/working/blocking detection).
 * Covers PRD §5.3, C-TURN-03, C-TURN-05.
 */

import { describe, expect, test } from "vitest";
import { claudeScreenFactTable } from "../../src/claude/screen-table.ts";
import {
  codexScreenFactTable,
  codexScreenFactTableForTrustPolicy,
} from "../../src/codex/screen-table.ts";
import { hasScreenFact, type RenderedFrame, readScreenFacts } from "../../src/core/screen-facts.ts";

const screen = (text: string, title = ""): RenderedFrame => ({ text, title });
// Footers captured from real sessions (claude 2.1.201, codex-cli 0.142.5).
const claudeIdle = "❯ \n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents";
const claudeWorking =
  "❯ \n  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← for agents";
const codexIdle = "› Explain this codebase\n  gpt-5.5 high";
const codexWorking = "• Working (3s • esc to interrupt)\n› Explain this codebase";
const codexInterrupted = "■ Conversation interrupted - tell the model what to do.\n› ";
const modalDialog = "Allow this tool?\n  1. Yes\n  2. No";
const workingTitle = "⠹ Claude Code";
const idleTitle = "✳ Claude Code";

describe("screen fact tables", () => {
  test("C-TURN-03 the working rules match both captured footers", () => {
    expect(
      readScreenFacts(claudeScreenFactTable, screen(claudeWorking)).facts.working_visible,
    ).toBe(true);
    expect(readScreenFacts(codexScreenFactTable, screen(codexWorking)).facts.working_visible).toBe(
      true,
    );
    expect(readScreenFacts(claudeScreenFactTable, screen(claudeIdle)).facts.working_visible).toBe(
      false,
    );
    expect(
      readScreenFacts(codexScreenFactTable, screen(codexInterrupted)).facts.working_visible,
    ).toBe(false);
  });

  test("C-TURN-05 the OSC title braille spinner signals working, independent of screen text", () => {
    // Narrow-screen frame with no visible footer token, but a spinner title.
    const narrow = readScreenFacts(claudeScreenFactTable, screen("streaming…\n❯ ", workingTitle));
    expect(narrow.facts.working_visible).toBe(true);
    expect(narrow.matched.map((rule) => rule.id)).toContain("claude-working-title");
    // The idle "✳ " title is not a working signal.
    expect(
      readScreenFacts(claudeScreenFactTable, screen(claudeIdle, idleTitle)).facts.working_visible,
    ).toBe(false);
    // Codex uses the same braille-title convention.
    expect(
      readScreenFacts(codexScreenFactTable, screen("done\n› ", "⠏ project")).facts.working_visible,
    ).toBe(true);
  });

  test("readings expose matched rule ids and regions for explain traces", () => {
    const reading = readScreenFacts(claudeScreenFactTable, screen(claudeWorking));
    expect(reading.matched.map((rule) => rule.id)).toEqual([
      "claude-composer-marker",
      "claude-working-footer",
    ]);
    expect(reading.matched.every((rule) => rule.region === "screen")).toBe(true);
    const titled = readScreenFacts(claudeScreenFactTable, screen("❯ ", workingTitle));
    expect(titled.matched.find((rule) => rule.id === "claude-working-title")?.region).toBe("title");
    expect(readScreenFacts(claudeScreenFactTable, screen(modalDialog)).matched).toEqual([]);
  });

  test("the codex composer_visible fact tracks the composer marker (turn-state, not readiness)", () => {
    // composer_visible feeds idle-turn detection; it is NOT a readiness signal
    // — the boot-time placeholder marker paints before input is accepted, so
    // Codex readiness is hook-backed (C-API-28), not composer-driven.
    expect(
      hasScreenFact(codexScreenFactTable, { text: codexIdle, title: "" }, "composer_visible"),
    ).toBe(true);
    expect(
      hasScreenFact(codexScreenFactTable, { text: modalDialog, title: "" }, "composer_visible"),
    ).toBe(false);
  });

  test("C-CODEX-12 Codex update screens block input without matching ordinary update prose", () => {
    const blocked = (text: string) =>
      readScreenFacts(codexScreenFactTable, screen(text)).facts.blocking_prompt_visible;
    // A first-party banner blocks before its options paint, so a new layout fails safe.
    expect(blocked("Update available! 0.151.0 -> 0.152.0")).toBe(true);
    // Cursor-addressed rendering can leave only the complete option set in the viewport.
    expect(blocked("› 1. Update now (runs `npm install`)\n  2. Skip until next version")).toBe(
      true,
    );
    // Neither half alone is enough to reinterpret ordinary agent text as a dialog.
    expect(blocked("Please update now after the tests pass.")).toBe(false);
    expect(blocked("The release notes say update available for all users.")).toBe(false);
    expect(blocked("0.149.1 to update.\nhttps://github.com/openai/codex")).toBe(false);
    expect(blocked("1. Skip this optional cleanup")).toBe(false);
    const tracked = codexScreenFactTableForTrustPolicy(true);
    expect(
      readScreenFacts(tracked, screen("Update available! 0.151.0 -> 0.152.0\n1. Update now")).facts
        .blocking_prompt_visible,
    ).toBe(true);
    expect(
      readScreenFacts(tracked, screen("2. Skip\n3. Skip until next version")).facts
        .blocking_prompt_visible,
    ).toBe(true);
    expect(readScreenFacts(tracked, screen("› ")).facts.blocking_prompt_visible).toBe(false);
  });

  test("hasScreenFact evaluates a single fact across screen and title regions", () => {
    // A title-region working rule matches the spinner title, not the screen.
    expect(
      hasScreenFact(claudeScreenFactTable, { text: "❯ ", title: workingTitle }, "working_visible"),
    ).toBe(true);
    // The same fact is absent when neither the footer nor the title spins.
    expect(
      hasScreenFact(claudeScreenFactTable, { text: "❯ ", title: idleTitle }, "working_visible"),
    ).toBe(false);
    // A screen-region rule still matches when the title is empty.
    expect(
      hasScreenFact(claudeScreenFactTable, { text: claudeWorking, title: "" }, "composer_visible"),
    ).toBe(true);
  });
});
