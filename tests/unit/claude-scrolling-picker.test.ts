/**
 * A Claude list longer than its ten-row window is still Elwood's own live picker, and its
 * rendered rows are all options: the `↑`/`↓` scroll markers and the `… +K models` line are
 * part of the dialog, never foreign content (PRD §5.3, C-API-23, C-API-24).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { claudeModelPicker } from "../../src/claude/model-picker.ts";
import { setPickerModel } from "../../src/core/models/picker.ts";
import type { ModelDialogAuthority } from "../../src/core/models/rows.ts";
import { scripted } from "./scripted-terminal.ts";

/** A real Claude 2.1.310 frame (2026-10-24): header to viewport bottom, 13 models. */
function frame(name: string): string {
  const url = new URL(`../fixtures/claude-2.1.310/model-picker/${name}.txt`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

const opened: ModelDialogAuthority = { opened: true };
const ids = (text: string) => claudeModelPicker.parse(text).options.map((option) => option.id);

test.each([
  "top-window",
  "cursor-on-down-marker",
  "cursor-on-last-visible-row",
  "both-markers",
  "bottom-of-list",
  "medium-effort",
  "opened-on-hidden-current",
  "opened-on-hidden-current-cursor-3",
  "effort-not-supported",
])("C-API-24 the captured 2.1.310 %s frame is a live picker", (name) => {
  expect(claudeModelPicker.activeDialog(frame(name), opened)).toBe("picker");
});

test.each([
  ["○ Low effort ←/→ to adjust"],
  ["◐ Medium effort (default) ←/→ to adjust"],
  ["● High effort (default) ←/→ to adjust"],
  ["◈ Max effort ←/→ to adjust"],
])("C-API-24 the measured effort row %s keeps the picker live", (control) => {
  const text = frame("top-window").replace("◉ xHigh effort ←/→ to adjust", control);
  expect(claudeModelPicker.activeDialog(text, opened)).toBe("picker");
});

test("C-API-23 scroll-marked rows are parsed as rendered options", () => {
  const top = claudeModelPicker.parse(frame("top-window"));
  expect(top.options).toHaveLength(10);
  expect(top.options[9]).toMatchObject({ id: "opus 4.8", isCurrent: false });
  expect(top.cursorIndex).toBe(0);
  expect(ids(frame("both-markers"))).toEqual([
    "fable 5.1",
    "sonnet 5.5",
    "haiku 5.5",
    "haiku 4.5",
    "sonnet 5",
    "opus 5",
    "fable 5",
    "opus 4.8",
    "opus 4.7",
    "opus 4.6",
  ]);
  const hidden = claudeModelPicker.parse(frame("opened-on-hidden-current"));
  expect(hidden.options[hidden.cursorIndex]).toMatchObject({ id: "opus 4.6", isCurrent: true });
});

/** Each layout keeps exactly one shape of window; anything else is not this dialog. */
test.each([
  ["a `↑` row below the first row", "    5.  Haiku 5.5  ", "  ↑ 5.  Haiku 5.5  "],
  ["an unmarked block starting past 1", "  ↑ 3.  Fable 5.1  ", "    3.  Fable 5.1  "],
  ["a `↑ 1.` row, which hides nothing", "  ↑ 3.  Fable 5.1  ", "  ↑ 1.  Fable 5.1  "],
  ["a row under the `↓` row", "     … +1 model", "    13. Sonnet 4.6               Efficient"],
  ["the overflow line apart from the rows", "     … +1 model", "\n     … +1 model"],
  ["a second overflow line", "     … +1 model", "     … +1 model\n     … +1 model"],
  ["a reply bullet as its control row", "◐ Medium effort (default) ←/→ to adjust", "● It shows:"],
])("C-API-24 a window with %s is not a live picker", (_name, from, to) => {
  const text = frame("both-markers").replace(from, to);
  expect(text).not.toBe(frame("both-markers"));
  expect(claudeModelPicker.activeDialog(text, opened)).toBeUndefined();
});

/**
 * The picker opened scrolled because the current model sits below the fold. Arrowing up
 * to row 3 scrolls the window one row, so the target's INDEX changes between the frame
 * Elwood planned from and the frame it lands on: only the row's identity is stable.
 */
test("C-API-24 setPickerModel lands on a target whose window scrolled under the cursor", async () => {
  const terminal = scripted(frame("opened-on-hidden-current"));
  let ups = 0;
  terminal.onInput = (input) => {
    if (input === "\u001b[A") ups += 1;
    if (ups === 9) terminal.text = frame("opened-on-hidden-current-cursor-3");
    if (input === "s") terminal.text = "❯ ";
  };
  await setPickerModel(
    { terminal, submit: () => Promise.resolve() },
    claudeModelPicker,
    "Fable 5.1",
    2_000,
  );
  expect(terminal.inputs).toEqual([...new Array<string>(9).fill("\u001b[A"), "s"]);
});
