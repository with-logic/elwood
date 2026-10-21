/** The captured post-question composer supports a successor round (C-API-56). */
import { expect, test } from "vitest";
import { claudeEmptyInputFrame } from "../../../src/claude/composer/empty-input.ts";
import { claudeModelComposerClearance } from "../../../src/claude/model-composer.ts";
import { claudeScreenFactTable, liveClaudeClearance } from "../../../src/claude/screen-table.ts";
import { readScreenFacts } from "../../../src/core/screen-facts.ts";
import { createHeadlessTerminal } from "../../../src/terminal/headless.ts";
import { fixture, nativeSnapshot } from "./helpers.ts";

test("C-API-56 actual manual-mode frame with earlier question prompts proves empty native input", async () => {
  const native = nativeSnapshot("accepted-manual-composer");
  const terminal = createHeadlessTerminal({ cols: native.cols, rows: native.rows }, () => {});
  try {
    await terminal.writeOutput(
      `\x1b[2J\x1b[H${native.lines.join("\r\n")}\x1b[?25h\x1b]0;✳ Claude Code\x07\x1b[${native.cursorY + 1};${native.cursorX + 1}H`,
    );
    expect(claudeModelComposerClearance(terminal.snapshot().text)).toBe(true);
    expect(
      liveClaudeClearance(() => terminal, claudeModelComposerClearance)(terminal.snapshot().text),
    ).toBe(true);
    expect(claudeEmptyInputFrame(terminal)).toBeDefined();
    await terminal.writeOutput("\x1b[?25l");
    expect(
      liveClaudeClearance(() => terminal, claudeModelComposerClearance)(terminal.snapshot().text),
    ).toBe(false);
    expect(
      claudeModelComposerClearance(
        native.text.replace("⏸ manual mode on · ? for shortcuts", "arbitrary footer"),
      ),
    ).toBe(false);
  } finally {
    terminal.dispose();
  }
});

test("C-TURN-03 captured questionnaire caret remains blocking rather than idle input", () => {
  const facts = readScreenFacts(claudeScreenFactTable, {
    text: fixture("questions").text,
    title: "",
  });
  expect(facts.facts.blocking_prompt_visible).toBe(true);
  expect(
    readScreenFacts(claudeScreenFactTable, {
      text: nativeSnapshot("accepted-manual-composer").text,
      title: "",
    }).facts.blocking_prompt_visible,
  ).toBe(false);
});
