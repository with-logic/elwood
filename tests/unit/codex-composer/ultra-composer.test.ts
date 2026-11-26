/** Native ultra-mode composer recognition and draft recovery (C-API-28/31/56, C-TRUST-01). */
import { expect, test } from "vitest";
import {
  codexComposerRowsClearance,
  codexReadinessEvidence,
} from "../../../src/codex/screen/clearance.ts";
import { codexEmptyInputFrame } from "../../../src/codex/screen/empty-input.ts";
import { codexInputStaged } from "../../../src/codex/screen/staged-input.ts";
import { codexScreenFactTable } from "../../../src/codex/screen-table.ts";
import { readScreenFacts } from "../../../src/core/screen-facts.ts";
import { createHeadlessTerminal } from "../../../src/terminal/headless.ts";
import { capturedFrame } from "../../helpers/captured-frames.ts";

const captured = capturedFrame("codex-0.169.0/ultra-composer");
const footer =
  "\n\n  GPT-6.2-Sol ultra · /tmp/elwood-ultra-CAPTURE\n  ← for agents · ? for shortcuts";

test("C-API-28 C-TRUST-01 captured ultra composer is configured and clear", () => {
  expect(codexReadinessEvidence(captured)).toBe(true);
  expect(codexComposerRowsClearance(captured.split("\n"))).toBe(true);
  expect(
    readScreenFacts(codexScreenFactTable, { text: captured, title: "workspace" }).facts
      .composer_visible,
  ).toBe(true);
  expect(codexComposerRowsClearance(`Allow command?\n  1. Yes\n${captured}`.split("\n"))).toBe(
    false,
  );
});

test("C-API-56 ultra input geometry acknowledges only the empty native composer", async () => {
  const terminal = createHeadlessTerminal({ cols: 189, rows: 60 }, () => undefined);
  try {
    await terminal.writeOutput(
      `\u001b[2J\u001b[H${`» Ask Codex to do anything${footer}`.replaceAll("\n", "\r\n")}\u001b[1;3H\u001b[?25h`,
    );
    expect(codexEmptyInputFrame(terminal)).toBeDefined();
    await terminal.writeOutput("\u001b[1;4H");
    expect(codexEmptyInputFrame(terminal)).toBeUndefined();
  } finally {
    terminal.dispose();
  }
});

test.each([
  {
    label: "image-only draft",
    draft: "» [Image #1]",
    payload: "hello",
    row: 0,
    column: 12,
    staged: true,
  },
  {
    label: "marker is not payload",
    draft: "» unrelated",
    payload: "»",
    row: 0,
    column: 11,
    staged: false,
  },
  { label: "text", draft: "» hello", payload: "hello", row: 0, column: 7, staged: true },
  {
    label: "wrapped text",
    draft: "» first\n  last",
    payload: "first\nlast",
    row: 1,
    column: 6,
    staged: true,
  },
  { label: "whitespace", draft: "»   ", payload: "  ", row: 0, column: 4, staged: true },
  {
    label: "unrelated draft",
    draft: "» unrelated",
    payload: "hello",
    row: 0,
    column: 11,
    staged: false,
  },
  {
    label: "placeholder",
    draft: "» Ask Codex to do anything",
    payload: "anything",
    row: 0,
    column: 12,
    staged: false,
  },
])("C-API-31 ultra $label is classified within its native composer", async ({
  draft,
  payload,
  row,
  column,
  staged,
}) => {
  const terminal = createHeadlessTerminal({ cols: 189, rows: 60 }, () => undefined);
  try {
    const frame = `${draft}${footer}`.replaceAll("\n", "\r\n");
    await terminal.writeOutput(
      `\u001b[2J\u001b[H${frame}\u001b[${row + 1};${column + 1}H\u001b[?25h`,
    );
    expect(codexInputStaged(terminal, payload)).toBe(staged);
  } finally {
    terminal.dispose();
  }
});
