/** Captured Codex 0.156.1 empty-composer clearance (PRD §5.4, C-API-56, C-TRUST-01). */
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  codexComposerRow,
  codexComposerRowsClearance,
} from "../../../src/codex/screen/clearance.ts";
import { liveCodexClearance } from "../../../src/codex/screen/live-clearance.ts";
import { createHeadlessTerminal } from "../../../src/terminal/headless.ts";

const captured = readFileSync(
  new URL("../../fixtures/codex-0.156.1/cleared-composer.txt", import.meta.url),
  "utf8",
).trimEnd();
const cursorRow = 11;

test("C-API-56 captured capitalized model footer acknowledges the native cleared composer", () => {
  const rows = captured.split("\n");
  expect(codexComposerRowsClearance(rows, cursorRow)).toBe(true);
  expect(codexComposerRowsClearance(rows)).toBe(true);
  expect(codexComposerRow(rows, false)).toBe(cursorRow);
});

test("C-TRUST-01 capitalized native footer still needs a live cursor on the composer", async () => {
  const terminal = createHeadlessTerminal({ cols: 189, rows: 48 }, () => undefined);
  const clear = liveCodexClearance(() => terminal);
  try {
    await terminal.writeOutput(`${captured.replaceAll("\n", "\r\n")}\u001b[12;3H\u001b[?25h`);
    expect(clear(terminal.snapshot().text)).toBe(true);
    await terminal.writeOutput("\u001b[?25l");
    expect(clear(terminal.snapshot().text)).toBe(false);
    await terminal.writeOutput("\u001b[?25h\u001b[14;3H");
    expect(clear(terminal.snapshot().text)).toBe(false);
    await terminal.writeOutput("\u001b[12;3H");
    expect(clear(terminal.snapshot().text)).toBe(true);
    await terminal.writeOutput(
      "\u001b7\u001b[1;1H\u001b[2KWould you like to run the following command?\u001b8",
    );
    expect(clear(terminal.snapshot().text)).toBe(false);
  } finally {
    terminal.dispose();
  }
});

test.each([
  {
    label: "staged draft",
    frame: captured.replace("› Ask Codex to do anything", "› staged caller draft"),
  },
  { label: "dialog options", frame: `${captured}\n  1. Yes\n  2. No` },
  {
    label: "working indicator",
    frame: captured.replace("› Ask", "• Working (3s • esc to interrupt)\n› Ask"),
  },
])("C-TRUST-01 capitalized footer cannot clear $label", ({ frame }) => {
  expect(codexComposerRowsClearance(frame.split("\n"))).toBe(false);
});
