/**
 * Unit tests for screen-fact tables and rendered-TUI turn-state watching.
 * Covers PRD §5.3, C-TURN-01 through C-TURN-05.
 */

import { describe, expect, test } from "vitest";
import { claudeScreenFactTable } from "../../src/claude/screen-table.ts";
import { codexComposerVisible, codexScreenFactTable } from "../../src/codex/screen-table.ts";
import { hasScreenFact, type RenderedFrame, readScreenFacts } from "../../src/core/screen-facts.ts";
import { TurnStateWatcher } from "../../src/core/turn-state.ts";

const screen = (text: string, title = ""): RenderedFrame => ({ text, title });
/** The watcher consumes pre-classified facts; classify with the given table. */
const facts = (table: Parameters<typeof readScreenFacts>[0], text: string, title = "") =>
  readScreenFacts(table, { text, title }).facts;

// Footers captured from real sessions (claude 2.1.201, codex-cli 0.142.5).
const claudeIdle = "❯ \n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents";
const claudeWorking =
  "❯ \n  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← for agents";
const codexIdle = "› Explain this codebase\n  gpt-5.5 high";
const codexWorking = "• Working (3s • esc to interrupt)\n› Explain this codebase";
const codexInterrupted = "■ Conversation interrupted - tell the model what to do.\n› ";
const modalDialog = "Allow this tool?\n  1. Yes\n  2. No";
// Braille-spinner titles captured from real sessions (claude 2.1.203).
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

  test("the codex composer helper reads the table", () => {
    expect(codexComposerVisible(codexIdle)).toBe(true);
    expect(codexComposerVisible(modalDialog)).toBe(false);
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
    // A fact with no rules is false without scanning others.
    expect(
      hasScreenFact(claudeScreenFactTable, { text: claudeWorking, title: "" }, "composer_visible"),
    ).toBe(true);
  });
});

describe("turn state watching", () => {
  test("C-TURN-01 edges fire on start and on any turn end", () => {
    const watcher = new TurnStateWatcher();
    watcher.arm();
    expect(watcher.observe(facts(claudeScreenFactTable, claudeIdle))).toBeUndefined();
    expect(watcher.observe(facts(claudeScreenFactTable, claudeWorking))).toBe("started");
    expect(watcher.observe(facts(claudeScreenFactTable, claudeWorking))).toBeUndefined();
    expect(watcher.observe(facts(claudeScreenFactTable, claudeIdle))).toBe("ended");
    expect(watcher.observe(facts(claudeScreenFactTable, claudeIdle))).toBeUndefined();
  });

  test("C-TURN-05 a turn can start from the OSC title alone on a narrow screen", () => {
    const watcher = new TurnStateWatcher();
    watcher.arm();
    // Footer elided at narrow width; only the spinner title reveals the turn.
    expect(watcher.observe(facts(claudeScreenFactTable, "streaming…\n❯ ", workingTitle))).toBe(
      "started",
    );
    expect(watcher.observe(facts(claudeScreenFactTable, claudeIdle, idleTitle))).toBe("ended");
  });

  test("C-TURN-02 an interrupt end needs no hook, only the rendered screen", () => {
    const watcher = new TurnStateWatcher();
    watcher.arm();
    expect(watcher.observe(facts(codexScreenFactTable, codexWorking))).toBe("started");
    expect(watcher.observe(facts(codexScreenFactTable, codexInterrupted))).toBe("ended");
  });

  test("C-TURN-03 unarmed watching reports nothing (startup spinners)", () => {
    const watcher = new TurnStateWatcher();
    expect(watcher.observe(facts(codexScreenFactTable, codexWorking))).toBeUndefined();
    expect(watcher.observe(facts(codexScreenFactTable, codexIdle))).toBeUndefined();
  });

  test("C-TURN-03 a screen with neither indicator holds the running state", () => {
    const watcher = new TurnStateWatcher();
    watcher.arm();
    expect(watcher.observe(facts(claudeScreenFactTable, claudeWorking))).toBe("started");
    expect(watcher.observe(facts(claudeScreenFactTable, modalDialog))).toBeUndefined();
    expect(watcher.observe(facts(claudeScreenFactTable, claudeIdle))).toBe("ended");
  });
});

// Banner lines captured from real interrupted sessions at 46 and 100 cols.
const claudeBanner46 = "  ⎿  Interrupted· What should Claude do \n❯ ";
const claudeBanner100 = "  ⎿  Interrupted · What should Claude do instead?\n❯ ";
const narrowClaudeWorking = "  essay text streaming, footer elided\n❯ ";

describe("C-TURN-04 interrupt end banners", () => {
  test("banner fires ended at narrow widths where working was never seen", () => {
    const watcher = new TurnStateWatcher();
    watcher.arm();
    expect(watcher.observe(facts(claudeScreenFactTable, narrowClaudeWorking))).toBeUndefined();
    expect(watcher.observe(facts(claudeScreenFactTable, claudeBanner46))).toBe("ended");
    // The banner persists on screen; the edge fires exactly once.
    expect(watcher.observe(facts(claudeScreenFactTable, claudeBanner46))).toBeUndefined();
  });

  test("banner works at wide sizes and re-arms after clearing", () => {
    const watcher = new TurnStateWatcher();
    watcher.arm();
    expect(watcher.observe(facts(claudeScreenFactTable, claudeWorking))).toBe("started");
    expect(watcher.observe(facts(claudeScreenFactTable, claudeBanner100))).toBe("ended");
    expect(watcher.observe(facts(claudeScreenFactTable, claudeWorking))).toBe("started");
    expect(watcher.observe(facts(claudeScreenFactTable, claudeBanner100))).toBe("ended");
  });

  test("banners match without colliding with the working token or prose", () => {
    const interrupted = readScreenFacts(
      codexScreenFactTable,
      screen("■ Conversation interrupted - tell"),
    );
    expect(interrupted.facts.interrupt_complete_visible).toBe(true);
    const working = readScreenFacts(codexScreenFactTable, screen(codexWorking));
    expect(working.facts.interrupt_complete_visible).toBe(false);
    const prose = readScreenFacts(
      claudeScreenFactTable,
      screen("the essay was Interrupted by rain"),
    );
    expect(prose.facts.interrupt_complete_visible).toBe(false);
  });
});
