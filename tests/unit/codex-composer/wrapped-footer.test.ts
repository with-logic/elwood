/**
 * Constructed wrapped-footer shapes and near misses at 160 columns (C-CODEX-26). The frames
 * here are built, not captured: they cover an agent label, a footer with no badge, and a
 * badge on the last status row, plus rows that must stay refused. Real captures are in
 * `wrapped-footer-captures.test.ts`.
 */
import { expect, test } from "vitest";
import {
  codexComposerClearance,
  codexComposerConfigured,
  codexComposerRowsEmpty,
} from "../../../src/codex/screen/clearance.ts";
import { codexFooterCaptures170 } from "../../fixtures/codex-footer-captures-170.ts";

const cols = 160;
const longDirectory = `~/${[
  "workspace",
  "area-0123456789abcdef",
  "group-fedcba9876543210",
  "nested-0123456789abcdef-fedcba9876543210",
  "tasks-0123456789abcdef",
  "item-fedcba9876543210",
  "checkout",
].join("/")}`;
const thread = "[note:first] You are an example, working on a long task that goes on and o…";
const badge = "⚠ 2 warnings · f2 to view";
const hintPrefix = "  ← for agents · ? for shortcuts";
const hint = (withBadge: boolean) =>
  withBadge ? hintPrefix + badge.padStart(cols - hintPrefix.length) : hintPrefix;

/** Break at a space, or after `/` or `-`, with a two-space indent, as the captures show. */
function wrap(text: string): string[] {
  const rows: string[] = [];
  let row = "  ";
  for (const piece of text.match(/[^\s/-]*[/-]|[^\s/-]+|\s+/g) ?? []) {
    if (row.length + piece.length > cols && row.trim() !== "") {
      rows.push(row.trimEnd());
      row = `  ${piece.trimStart()}`;
    } else row += piece;
  }
  return [...rows, row.trimEnd()];
}

/** The row at `at`; a fixture that lost the row fails here, not as a blank row. */
function rowAt(rows: readonly string[], at: number): string {
  const row = rows.at(at);
  if (row === undefined) throw new Error(`The fixture has no row ${at}.`);
  return row;
}

function screen(footer: readonly string[], below: readonly string[] = []): string {
  return ["• reply text", "", "› Ask Codex to do anything", "", ...footer, ...below].join("\n");
}
const status = (directory: string, label = "", name = thread) =>
  wrap(`GPT-6-Astra xhigh · ${directory} · ${name}${label}`);
const verdict = (frame: string, width = cols) => [
  codexComposerConfigured(frame, width),
  codexComposerClearance(frame, { cols: width }),
];
const accepted = (frame: string, width = cols) => verdict(frame, width).every(Boolean);
const refused = (frame: string, width = cols) => !verdict(frame, width).some(Boolean);

test("C-CODEX-26 the constructed footers wrap to two and three rows at 160 columns", () => {
  expect(status(longDirectory)).toHaveLength(2);
  expect(status(longDirectory, " · Main [default]")).toHaveLength(2);
  expect(status(longDirectory, "", `${thread} ${thread}`)).toHaveLength(3);
  expect(status("~/short")).toHaveLength(1);
});

test.each([
  { label: "an agent label", rows: status(longDirectory, " · Main [default]"), below: hint(true) },
  { label: "no badge", rows: status(longDirectory), below: hint(false) },
  {
    label: "three rows with an agent label",
    rows: status(longDirectory, " · Main [default]", `${thread} ${thread}`),
    below: hint(true),
  },
])("C-CODEX-26 recognizes a wrapped footer with $label", ({ rows, below }) => {
  expect(accepted(screen(rows, [below]))).toBe(true);
});

test.each([
  { label: "an agent label", rows: status(longDirectory, " · Main [default]") },
  { label: "no agent label", rows: status(longDirectory) },
])("C-CODEX-26 recognizes the badge on the last status row with no hint row: $label", ({
  rows,
}) => {
  expect(accepted(screen([...rows.slice(0, -1), `${rowAt(rows, -1)} ${badge}`]))).toBe(true);
});

test("C-CODEX-26 a narrow wrapped footer needs no badge at the terminal's edge", () => {
  // The status rows Codex drew at 46 columns; the hint row is constructed without a badge.
  const capture = codexFooterCaptures170.find(({ cols, wrapped }) => cols === 46 && wrapped);
  const rows = capture?.rows.slice(0, -1) ?? [];
  expect(rows).toHaveLength(5);
  expect(accepted(rows.join("\n"), 46)).toBe(true);
  expect(accepted([...rows, "  ← for agents · ? for shortcuts"].join("\n"), 46)).toBe(true);
  expect(refused(rows.join("\n"), 184)).toBe(true);
});

test("C-CODEX-26 a wrapped footer is also empty-input evidence at the composer row", () => {
  const rows = screen(status(longDirectory), [hint(true)]).split("\n");
  expect(codexComposerRowsEmpty(rows, { cursorRow: 2, cols })).toBe(true);
  expect(codexComposerRowsEmpty(rows, { cursorRow: 2 })).toBe(false);
});

test("C-CODEX-26 a continuation-looking row with no status row above is not evidence", () => {
  const second = rowAt(status(longDirectory, " · Main [default]"), 1);
  expect(refused(screen([second]))).toBe(true);
  expect(refused(screen([second], [hint(true)]))).toBe(true);
  expect(refused(screen(["", second]))).toBe(true);
});

test("C-CODEX-26 a reply paragraph ending in an agent label is not a footer", () => {
  const reply = `  the rest of a reply paragraph that merely ends the way a footer would · Main [default]`;
  expect(refused(["• a reply", reply, "", "› Ask Codex to do anything", ""].join("\n"))).toBe(true);
  // Below the composer, a short status row left room for `the`: the row is no continuation.
  expect(refused(screen(["  GPT-6-Astra xhigh · ~/short", reply], [hint(true)]))).toBe(true);
  expect(refused(screen([reply, ...status(longDirectory)]))).toBe(true);
});

test("C-CODEX-26 a status row followed by an unrelated row is not clearance", () => {
  const rows = status(longDirectory);
  const [first, second] = [rowAt(rows, 0), rowAt(rows, 1)];
  expect(refused(screen([first, "• streamed reply text"]))).toBe(true);
  expect(refused(screen([first, "› another prompt row"]))).toBe(true);
  expect(refused(screen([first, "    2. numbered option"]))).toBe(true);
  expect(refused(screen([first, "", second]))).toBe(true);
  expect(refused(screen([...rows, "Heads up"]))).toBe(true);
  expect(refused(screen([...rows, hint(true), second]))).toBe(true);
});

test.each([
  "⚠ 2 alerts · f2 to view",
  "⚠ 0 warnings · f2 to view",
  "⚠ 0 · f2",
  "⚠ two · f2",
])("C-CODEX-26 the unknown badge %s on a continuation row is not clearance", (unknown) => {
  const rows = status(longDirectory);
  expect(refused(screen([rowAt(rows, 0), `${rowAt(rows, 1)} ${unknown}`]))).toBe(true);
});

test.each([
  46, 80, 160,
])("C-CODEX-26 a status row that left room for the next word did not wrap at %i columns", (width) => {
  // `something` and `Press` had room beside the short status row at every one of the widths.
  const short = "  GPT-6-Astra xhigh · ~/short";
  expect(refused(screen([short, "  something else entirely"], [hint(true)]), width)).toBe(true);
  expect(refused(screen([short, "  Press Enter to continue"]), width)).toBe(true);
  expect(refused(screen([short, "  Press Enter to continue"], [hint(false)]), width)).toBe(true);
  expect(accepted(screen([short]), width)).toBe(true);
});

test("C-CODEX-26 a word that fits to the last column was not moved by the width", () => {
  // The 29-column status row, one space and the word are 60 columns: all of a 60-column row.
  const short = "  GPT-6-Astra xhigh · ~/short";
  expect(short).toHaveLength(29);
  expect(refused(screen([short, `  ${"x".repeat(30)}`]), 60)).toBe(true);
  // One column more could not have fitted, so the terminal's width did cut the row.
  expect(accepted(screen([short, `  ${"x".repeat(31)}`]), 60)).toBe(true);
  expect(accepted(screen([short, `  ${"x".repeat(30)}`]), 59)).toBe(true);
});
