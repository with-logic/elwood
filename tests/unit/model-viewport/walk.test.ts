/** Full native model catalogs and physical selection across disclosures (C-API-23/24). */
import { expect, test } from "vitest";
import { claudeModelPicker } from "../../../src/claude/model-picker.ts";
import { codexModelPicker } from "../../../src/codex/model-picker.ts";
import { listPickerModels, setPickerModel } from "../../../src/core/models/picker.ts";
import { viewportTerminal } from "./terminal.ts";

const submit = () => Promise.resolve();

test("C-API-23 expands Claude's disclosure and lists every model without changing it", async () => {
  const { terminal, state } = viewportTerminal("claude");
  const models = await listPickerModels({ terminal, submit }, claudeModelPicker, 2_000);
  expect(models.map((model) => model.id)).toEqual([
    "claude-fixture-1",
    "claude-fixture-2",
    "claude-fixture-3",
    "claude-fixture-4",
    "claude-fixture-5",
    "claude-fixture-6",
    "claude-fixture-7",
  ]);
  expect(models.filter((model) => model.isCurrent).map((model) => model.id)).toEqual([
    "claude-fixture-2",
  ]);
  expect(models.filter((model) => model.isDefault).map((model) => model.id)).toEqual([
    "claude-fixture-1",
  ]);
  expect(state.expansions).toBe(1);
  expect(state.selected).toBe(2);
  expect(terminal.inputs.at(-1)).toBe("\u001b");
});

test("C-API-23 an opened scrolled Claude catalog walks both physical ends", async () => {
  const { terminal, state } = viewportTerminal("claude", { expanded: true, cursor: 6 });
  const models = await listPickerModels({ terminal, submit }, claudeModelPicker, 2_000);
  expect(models.map((model) => model.id)).toEqual([
    "claude-fixture-1",
    "claude-fixture-2",
    "claude-fixture-3",
    "claude-fixture-4",
    "claude-fixture-5",
    "claude-fixture-6",
    "claude-fixture-7",
  ]);
  expect(state.expansions).toBe(0);
});

test("C-API-24 a legacy model selection crosses the non-model disclosure", async () => {
  const { terminal, state } = viewportTerminal("claude");
  await setPickerModel({ terminal, submit }, claudeModelPicker, "claude-fixture-7", 2_000);
  expect(state.selected).toBe(7);
  expect(state.expansions).toBe(1);
  expect(terminal.inputs.at(-1)).toBe("s");
});

test("C-API-24 a visible primary model does not require expanding the catalog", async () => {
  const { terminal, state } = viewportTerminal("claude");
  await setPickerModel({ terminal, submit }, claudeModelPicker, "claude-fixture-1", 2_000);
  expect(state.selected).toBe(1);
  expect(state.expansions).toBe(0);
});

test("C-API-24 selects the second custom label across a scrolling disclosure", async () => {
  const { terminal, state } = viewportTerminal("claude");
  const labels = (text: string) =>
    text.replace("claude-fixture-6", "Project A").replace("claude-fixture-7", "Project B");
  const input = terminal.onInput;
  terminal.text = labels(terminal.text);
  terminal.onInput = (key) => {
    input?.(key);
    terminal.text = labels(terminal.text);
  };
  await setPickerModel({ terminal, submit }, claudeModelPicker, "PROJECT B", 500);
  expect(state.selected).toBe(7);
  expect(state.expansions).toBe(1);
  expect(terminal.inputs.at(-1)).toBe("s");
});

test("C-API-24 selection can move from the disclosure back across primary models", async () => {
  const { terminal, state } = viewportTerminal("claude", { expanded: true, cursor: 2 });
  await setPickerModel({ terminal, submit }, claudeModelPicker, "claude-fixture-1", 2_000);
  expect(state.selected).toBe(1);
});

test("C-API-24 unknown Claude model ids report the expanded catalog", async () => {
  const { terminal, state } = viewportTerminal("claude");
  await expect(
    setPickerModel({ terminal, submit }, claudeModelPicker, "absent", 2_000),
  ).rejects.toMatchObject({
    code: "model_automation_failed",
    details: {
      available: [
        "claude-fixture-1",
        "claude-fixture-2",
        "claude-fixture-3",
        "claude-fixture-4",
        "claude-fixture-5",
        "claude-fixture-6",
        "claude-fixture-7",
      ],
    },
  });
  expect(state.selected).toBe(2);
  expect(terminal.inputs.at(-1)).toBe("\u001b");
});

test.each([0, 9])("C-API-23 Codex walks uncounted windows opened at item %i", async (cursor) => {
  const { terminal, state } = viewportTerminal("codex", { cursor });
  const models = await listPickerModels({ terminal, submit }, codexModelPicker, 2_000);
  expect(models.map((model) => model.id)).toEqual(
    Array.from({ length: 10 }, (_, i) => `model${i + 1}`),
  );
  expect(state.selected).toBe(2);
  expect(terminal.inputs.at(-1)).toBe("\u001b");
});

test("C-API-24 Codex selects a model beyond the first uncounted window", async () => {
  const { terminal, state } = viewportTerminal("codex");
  await setPickerModel({ terminal, submit }, codexModelPicker, "model10", 2_000);
  expect(state.cursor).toBe(9);
  expect(terminal.inputs.slice(-2)).toEqual(["\r", "\r"]);
});
