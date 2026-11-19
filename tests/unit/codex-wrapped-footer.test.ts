/** A status footer Codex wraps at the terminal's width is still the status footer (C-CODEX-26). */
import { expect, test } from "vitest";
import {
  codexComposerClearance,
  codexComposerConfigured,
  codexComposerRowsEmpty,
} from "../../src/codex/screen/clearance.ts";

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
const hint = (withBadge: boolean) =>
  `  ← for agents · ? for shortcuts${withBadge ? `${" ".repeat(cols - 32 - badge.length)}${badge}` : ""}`;

/** Break at a space or after a path separator, as Codex does, with two-space indent. */
function wrap(text: string): string[] {
  const rows: string[] = [];
  let row = "  ";
  for (const piece of text.match(/[^\s/]*\/|[^\s/]+|\s+/g) ?? []) {
    if (row.length + piece.length > cols && row.trim() !== "") {
      rows.push(row.trimEnd());
      row = `  ${piece.trimStart()}`;
    } else row += piece;
  }
  return [...rows, row.trimEnd()];
}

function screen(footer: readonly string[], below: readonly string[] = []): string {
  return ["• reply text", "", "› Ask Codex to do anything", "", ...footer, ...below].join("\n");
}
const status = (directory: string, label = "", name = thread) =>
  wrap(`GPT-6-Astra xhigh · ${directory} · ${name}${label}`);
const verdict = (frame: string) => [codexComposerConfigured(frame), codexComposerClearance(frame)];
const accepted = (frame: string) => verdict(frame).every(Boolean);
const refused = (frame: string) => !verdict(frame).some(Boolean);

test("C-CODEX-26 the fixtures wrap to the shapes captured at 160 columns", () => {
  expect(status(longDirectory)).toHaveLength(2);
  expect(status(longDirectory, " · Main [default]")).toHaveLength(2);
  expect(status(longDirectory, "", `${thread} ${thread}`)).toHaveLength(3);
});

test.each([
  { label: "two rows", rows: status(longDirectory), below: [hint(true)] },
  {
    label: "two rows with an agent label",
    rows: status(longDirectory, " · Main [default]"),
    below: [hint(true)],
  },
  { label: "two rows, no badge", rows: status(longDirectory), below: [hint(false)] },
  {
    label: "three rows",
    rows: status(longDirectory, "", `${thread} ${thread}`),
    below: [hint(true)],
  },
  {
    label: "three rows with an agent label",
    rows: status(longDirectory, " · Main [default]", `${thread} ${thread}`),
    below: [hint(true)],
  },
])("C-CODEX-26 recognizes a wrapped footer: $label", ({ rows, below }) => {
  expect(accepted(screen(rows, below))).toBe(true);
});

test("C-CODEX-26 recognizes the badge on the last status row with no hint row", () => {
  const rows = status(longDirectory, " · Main [default]");
  expect(accepted(screen([...rows.slice(0, -1), `${rows.at(-1)} ${badge}`]))).toBe(true);
  expect(
    accepted(screen(rows.map((row, at) => (at === rows.length - 1 ? `${row} ${badge}` : row)))),
  ).toBe(true);
  const bare = status(longDirectory);
  expect(accepted(screen([...bare.slice(0, -1), `${bare.at(-1)} ${badge}`]))).toBe(true);
});

test("C-CODEX-26 a wrapped footer is also empty-input evidence at the composer row", () => {
  const rows = screen(status(longDirectory), [hint(true)]).split("\n");
  expect(codexComposerRowsEmpty(rows, 2)).toBe(true);
});

test("C-CODEX-26 a short directory is unchanged: one status row, with or without a label", () => {
  for (const frame of [
    screen(status("~/short"), [hint(true)]),
    screen(status("~/short", " · Main [default]"), [hint(false)]),
    screen([`  GPT-6-Astra xhigh · ~/short`]),
  ])
    expect(accepted(frame)).toBe(true);
  expect(status("~/short")).toHaveLength(1);
});

test("C-CODEX-26 a continuation-looking row with no status row above is not evidence", () => {
  const rows = status(longDirectory, " · Main [default]");
  expect(refused(screen([rows[1] as string]))).toBe(true);
  expect(refused(screen([rows[1] as string], [hint(true)]))).toBe(true);
  expect(refused(screen(["", rows[1] as string]))).toBe(true);
});

test("C-CODEX-26 a reply paragraph ending in an agent label is not a footer", () => {
  const reply = `  the rest of a reply paragraph that merely ends the way a footer would · Main [default]`;
  expect(refused(["• a reply", reply, "", "› Ask Codex to do anything", ""].join("\n"))).toBe(true);
  // Below the composer, a short status row is not full width: its next row is no continuation.
  expect(refused(screen(["  GPT-6-Astra xhigh · ~/short", reply], [hint(true)]))).toBe(true);
  expect(refused(screen([reply, ...status(longDirectory)]))).toBe(true);
});

test("C-CODEX-26 a status row followed by an unrelated row is not clearance", () => {
  const rows = status(longDirectory);
  expect(refused(screen([rows[0] as string, "• streamed reply text"]))).toBe(true);
  expect(refused(screen([rows[0] as string, "› another prompt row"]))).toBe(true);
  expect(refused(screen([rows[0] as string, "    2. numbered option"]))).toBe(true);
  expect(refused(screen([rows[0] as string, "", rows[1] as string]))).toBe(true);
  expect(refused(screen([...rows, "Heads up"]))).toBe(true);
  expect(refused(screen([...rows, hint(true), rows[1] as string]))).toBe(true);
});

test("C-CODEX-26 an unknown badge on a continuation row is not clearance", () => {
  const rows = status(longDirectory);
  expect(refused(screen([rows[0] as string, `${rows[1]} ⚠ 2 alerts · f2 to view`]))).toBe(true);
  expect(refused(screen([rows[0] as string, `${rows[1]} ⚠ 0 warnings · f2 to view`]))).toBe(true);
});

test("C-CODEX-26 a status row that left room for the next piece did not wrap", () => {
  // The hint row's badge reaches the terminal's width; a row far short of it, followed by a
  // short piece, was not cut by the terminal, so what follows is not its continuation.
  expect(
    refused(screen(["  GPT-6-Astra xhigh · ~/short", "  something else entirely"], [hint(true)])),
  ).toBe(true);
});

test("C-CODEX-26 a status row narrower than any terminal Codex runs in was not cut", () => {
  const short = ["  GPT-6-Astra xhigh · ~/short", "  Press Enter to continue"];
  expect(refused(screen(short))).toBe(true);
  expect(refused(screen(short, [hint(false)]))).toBe(true);
});
