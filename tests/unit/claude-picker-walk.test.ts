/**
 * Listing and selecting every row of a Claude picker longer than its ten-row window, by
 * replaying key-by-key walks captured from the real 2.1.310 CLI (PRD §5.3, C-API-23,
 * C-API-24).
 */
import { expect, test } from "vitest";
import { claudeModelPicker } from "../../src/claude/model-picker.ts";
import { listPickerModels, setPickerModel } from "../../src/core/models/picker.ts";
import {
  catalog,
  down,
  escapeKey,
  fromTop,
  io,
  openedScrolled,
  replay,
  topWindow,
  up,
} from "./claude-picker-walk-replay.ts";
import { scripted } from "./scripted-terminal.ts";

test("C-API-23 a picker opened at the top lists all 13 rows, not its ten-row window", async () => {
  const terminal = replay(fromTop);
  const models = await listPickerModels(io(terminal), claudeModelPicker, 2_000);
  expect(models.map((model) => model.id)).toEqual(catalog);
  expect(models.filter((model) => model.isCurrent).map((model) => model.id)).toEqual(["default"]);
  expect(models.filter((model) => model.isDefault).map((model) => model.id)).toEqual(["default"]);
  // Down to the last row and no further (the CLI wraps there), then Escape.
  expect(terminal.inputs).toEqual([...new Array<string>(12).fill(down), escapeKey]);
});

test("C-API-23 the visible rows keep the window they opened in; revealed rows are appended", async () => {
  const models = await listPickerModels(io(replay(fromTop)), claudeModelPicker, 2_000);
  expect(models.slice(0, 10)).toEqual(claudeModelPicker.parse(fromTop.opening).options);
  expect(models[12]?.raw).toMatch(/^❯ 13\. Sonnet 4\.6 /);
});

test("C-API-23 a picker opened scrolled on a hidden current row lists the rows above and below", async () => {
  const terminal = replay(openedScrolled);
  const models = await listPickerModels(io(terminal), claudeModelPicker, 2_000);
  expect(models.map((model) => model.id)).toEqual(catalog);
  expect(models.find((model) => model.isCurrent)?.id).toBe("opus 4.6");
  // One row down reveals row 13; up to row 2 brings rows 2 and 1 into the window.
  expect(terminal.inputs).toEqual([down, ...new Array<string>(11).fill(up), escapeKey]);
});

test("C-API-24 setPickerModel walks only until a row hidden below the window is rendered", async () => {
  const terminal = replay(fromTop);
  await setPickerModel(io(terminal), claudeModelPicker, "Opus 4.6", 2_000);
  // Row 12 comes into view with the cursor on it: no key past it, and no walk back.
  expect(terminal.inputs).toEqual([...new Array<string>(11).fill(down), "s"]);
});

test("C-API-24 setPickerModel on a picker opened scrolled selects the hidden last row in one key", async () => {
  const terminal = replay(openedScrolled);
  await setPickerModel(io(terminal), claudeModelPicker, "sonnet 4.6", 2_000);
  expect(terminal.inputs).toEqual([down, "s"]);
});

test("C-API-24 setPickerModel on a picker opened scrolled selects a row hidden above it", async () => {
  const terminal = replay(openedScrolled);
  await setPickerModel(io(terminal), claudeModelPicker, "opus 5.5", 2_000);
  // Row 13 first (unseen below), then up: row 2 comes into view with the cursor on row 3,
  // and one more `↑` lands on it. The list's first row is never needed.
  expect(terminal.inputs).toEqual([down, ...new Array<string>(11).fill(up), "s"]);
});

test("C-API-24 an unknown id lists every row, hidden ones included", async () => {
  const terminal = replay(fromTop);
  await expect(
    setPickerModel(io(terminal), claudeModelPicker, "opus 9", 2_000),
  ).rejects.toMatchObject({
    code: "model_automation_failed",
    message: 'Unknown model id "opus 9".',
    details: { available: catalog },
  });
  expect(terminal.inputs).toEqual([...new Array<string>(12).fill(down), escapeKey]);
});

test("C-API-23 a window that never moves fails within the timeout after one key", async () => {
  const terminal = scripted(fromTop.opening);
  await expect(listPickerModels(io(terminal), claudeModelPicker, 300)).rejects.toMatchObject({
    code: "model_automation_failed",
    message: "Timed out waiting for claude picker cursor on row 2 of 13.",
  });
  expect(terminal.inputs).toEqual([down]);
});

test("C-API-24 a moved cursor is not read once the picker is no longer the live dialog", async () => {
  // The expected frame with a composer row under it: transcript text, not a dialog.
  const quoted = `${fromTop.steps[1]?.frame}\n❯ `;
  expect(claudeModelPicker.activeDialog(quoted, { opened: true })).toBeUndefined();
  const terminal = replay(fromTop);
  const replayed = terminal.onInput;
  terminal.onInput = (input) => {
    replayed?.(input);
    if (terminal.inputs.length === 2) terminal.text = quoted;
  };
  await expect(listPickerModels(io(terminal), claudeModelPicker, 300)).rejects.toMatchObject({
    message: "Timed out waiting for claude picker cursor on row 3 of 13.",
  });
  expect(terminal.inputs).toEqual([down, down]);
});

test("C-API-23 an abort mid-walk writes no further key", async () => {
  const terminal = replay(fromTop);
  const deadline = new AbortController();
  const replayed = terminal.onInput;
  terminal.onInput = (input) => {
    replayed?.(input);
    if (terminal.inputs.length === 3) deadline.abort(new Error("deadline"));
  };
  await expect(
    listPickerModels(io(terminal, deadline.signal), claudeModelPicker, 2_000),
  ).rejects.toThrow("deadline");
  expect(terminal.inputs).toEqual([down, down, down]);
});

test("C-API-23 a scrolled window without a painted cursor is never walked", async () => {
  const frame = topWindow.replace("❯ 1.", "  1.");
  const terminal = scripted(frame);
  await expect(listPickerModels(io(terminal), claudeModelPicker, 2_000)).rejects.toMatchObject({
    code: "model_automation_failed",
    message: "Could not locate the picker cursor.",
    details: { available: catalog.slice(0, 10) },
  });
  expect(terminal.inputs).toEqual([]);
});
