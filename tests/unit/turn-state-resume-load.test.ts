/**
 * Resume settling through a CLI-announced conversation load: Codex 0.164.0 paints
 * "Resuming session…" above a live composer before it loads and replays the
 * conversation under a working title. Covers PRD §5.3 and C-TURN-03.
 */

import { describe, expect, test } from "vitest";
import { claudeScreenFactTable } from "../../src/claude/screen-table.ts";
import { codexScreenFactTable } from "../../src/codex/screen-table.ts";
import { readScreenFacts } from "../../src/core/screen-facts.ts";
import { type TurnEdge, TurnStateWatcher } from "../../src/core/turn-state.ts";

// Rows from tests/fixtures/codex-0.164.0/resume/*.json (captured 2026-10-25).
const header = "  >_ OpenAI Codex (v0.164.0)\n     /tmp/elwood_e2e_codex-FIXTUR\n";
const loading = `${header}  Resuming session…\n\n› Ask Codex to do anything\n\n  ? for shortcuts`;
const replayed = `${header}› Reply exactly: OK. Do not use tools.\n\n• OK.\n\n› Ask Codex to do anything`;
const replayedInterrupted = replayed.replace(
  "• OK.",
  "• OK.\n\n■ Conversation interrupted - use /feedback if something went wrong",
);
const spinner = "⠋ elwood_e2e_codex-FIXTUR";
const idle = "elwood_e2e_codex-FIXTUR";
const codex = (text: string, title = idle) =>
  readScreenFacts(codexScreenFactTable, { text, title });
const at = (text: string, title = idle) => codex(text, title).facts;

const repeat = <T>(count: number, value: T): T[] => Array.from({ length: count }, () => value);
/** Every edge `frames` produce; settling frames must all be undefined. */
const edges = (watcher: TurnStateWatcher, frames: ReturnType<typeof at>[]) =>
  frames.map((frame): TurnEdge | undefined => watcher.observe(frame));

describe("C-TURN-03 resume settling through a CLI-announced load", () => {
  test("the Codex placeholder is its own fact, never another adapter's", () => {
    const reading = codex(loading);
    expect(reading.facts).toMatchObject({ resume_loading_visible: true, composer_visible: true });
    expect(reading.matched.map((rule) => rule.id)).toContain("codex-resume-loading");
    expect(at(replayed).resume_loading_visible).toBe(false);
    const claude = readScreenFacts(claudeScreenFactTable, { text: loading, title: "" });
    expect(claude.facts.resume_loading_visible).toBe(false);
  });

  test("placeholder repaints never settle; the quiet composer after the load does", () => {
    const watcher = new TurnStateWatcher();
    watcher.arm(true);
    // Codex repaints the placeholder frame many times before it starts loading. Those
    // frames once filled the quiet streak, so the load's spinner became a phantom turn.
    const placeholder = repeat(10, at(loading));
    const load = [at(replayed, spinner), at(replayed, spinner), at(replayed)];
    expect(edges(watcher, [...placeholder, ...load])).toEqual(repeat(13, undefined));
    // An idle Codex does not repaint, so that one quiet frame had to release settling.
    expect(watcher.observe(at(replayed, spinner))).toBe("started");
    expect(watcher.observe(at(replayed))).toBe("ended");
  });

  test("a load that starts under the placeholder and replays an interrupt stays silent", () => {
    const watcher = new TurnStateWatcher();
    watcher.arm(true);
    const frames = [
      at(loading),
      at(loading, spinner),
      at(replayedInterrupted, spinner),
      at(replayedInterrupted),
    ];
    expect(edges(watcher, frames)).toEqual([undefined, undefined, undefined, undefined]);
    expect(watcher.observe(at(replayedInterrupted, spinner))).toBe("started");
  });

  test("a placeholder that clears without load work falls back to the full quiet streak", () => {
    const watcher = new TurnStateWatcher();
    watcher.arm(true);
    // No spinner ever follows the placeholder, so only the five-frame streak releases.
    expect(edges(watcher, [at(loading), ...repeat(5, at(replayed))])).toEqual(repeat(6, undefined));
    expect(watcher.observe(at(replayed, spinner))).toBe("started");
  });

  test("a spinner after the placeholder cleared still belongs to the load", () => {
    const watcher = new TurnStateWatcher();
    watcher.arm(true);
    expect(edges(watcher, [at(loading), ...repeat(4, at(replayed))])).toEqual(repeat(5, undefined));
    // Four quiet frames are short of the streak, so this frame is still the load's.
    expect(watcher.observe(at(replayed, spinner))).toBeUndefined();
    expect(watcher.observe(at(replayed))).toBeUndefined();
    expect(watcher.observe(at(replayed, spinner))).toBe("started");
  });

  test("without a placeholder one quiet frame after work does not settle", () => {
    const watcher = new TurnStateWatcher();
    watcher.arm(true);
    expect(edges(watcher, [at(replayed, spinner), at(replayed)])).toEqual([undefined, undefined]);
    expect(watcher.observe(at(replayed, spinner))).toBeUndefined();
  });
});
