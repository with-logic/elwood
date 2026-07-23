/**
 * Unit tests for screen-fact tables and rendered-TUI turn-state watching.
 * Covers PRD §5.3, C-TURN-01 through C-TURN-05.
 */

import { describe, expect, test } from "vitest";
import { claudeScreenFactTable } from "../../src/claude/screen-table.ts";
import { codexScreenFactTable } from "../../src/codex/screen-table.ts";
import { type RenderedFrame, readScreenFacts } from "../../src/core/screen-facts.ts";
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

  test("a resume arm swallows the replay's working flash — no phantom turn", () => {
    // A resumed CLI marks ready on its first composer frame, then repaints
    // the prior transcript; footer lines in that replay read as working.
    // Those flashes are history, not work (one phantom per resume otherwise).
    const watcher = new TurnStateWatcher();
    watcher.arm(true);
    expect(watcher.observe(facts(codexScreenFactTable, codexWorking))).toBeUndefined();
    expect(watcher.observe(facts(codexScreenFactTable, codexWorking))).toBeUndefined();
    // First QUIET composer frame settles the replay…
    expect(watcher.observe(facts(codexScreenFactTable, codexIdle))).toBeUndefined();
    // …after which a REAL turn is watched exactly like a cold start's.
    expect(watcher.observe(facts(codexScreenFactTable, codexWorking))).toBe("started");
    expect(watcher.observe(facts(codexScreenFactTable, codexIdle))).toBe("ended");
  });

  test("a resume arm that opens straight onto a quiet composer settles immediately", () => {
    const watcher = new TurnStateWatcher();
    watcher.arm(true);
    expect(watcher.observe(facts(codexScreenFactTable, codexIdle))).toBeUndefined();
    expect(watcher.observe(facts(codexScreenFactTable, codexWorking))).toBe("started");
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

  test("evidence-running releases resume settling — a queued turn's rendered end-edge is not swallowed", () => {
    const watcher = new TurnStateWatcher();
    watcher.arm(true); // resume: settling
    // A message drained at resume-readiness starts a REAL turn (evidence sets
    // running) whose spinner paints before any quiet composer frame.
    expect(watcher.observe(facts(codexScreenFactTable, codexWorking), true)).toBeUndefined();
    // Settling released by the evidence — the turn's END edge is observed.
    expect(watcher.observe(facts(codexScreenFactTable, codexIdle), true)).toBe("ended");
  });

  test("evidence-running release evaluates the CURRENT frame — a first idle frame is the end edge", () => {
    // The turn ended exactly as the running evidence arrived, so the FIRST frame
    // after release is already the quiet composer. Releasing settling must not
    // discard it: that idle frame is the turn's only end edge and must fire "ended".
    const watcher = new TurnStateWatcher();
    watcher.arm(true); // resume: settling
    expect(watcher.observe(facts(codexScreenFactTable, codexIdle), true)).toBe("ended");
  });
});
