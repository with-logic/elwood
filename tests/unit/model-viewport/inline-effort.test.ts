/** Inline and footer effort hints remain native picker layouts (C-API-23/24). */
import { expect, test } from "vitest";
import { claudeModelPicker } from "../../../src/claude/model-picker.ts";
import { listPickerModels } from "../../../src/core/models/picker.ts";
import { capturedFrame } from "../../helpers/captured-frames.ts";
import { viewportTerminal } from "./terminal.ts";

test("C-API-24 recognizes the captured Claude 2.1.326 inline effort hint", () => {
  const frame = capturedFrame("claude-2.1.326/model-picker/collapsed");
  expect(claudeModelPicker.activeDialog(frame, { opened: true })).toBe("picker");
  expect(claudeModelPicker.isCandidate(frame)).toBe(true);
  expect(claudeModelPicker.parse(frame).options).toHaveLength(5);
});

test("C-API-23 walks the disclosure when effort adjustment stays inline", async () => {
  const { terminal, state } = viewportTerminal("claude");
  const inline = (text: string) =>
    text.replace("◐ Medium effort (default)", "◐ Medium effort (default) ←/→ to adjust");
  const onInput = terminal.onInput;
  terminal.text = inline(terminal.text);
  terminal.onInput = (input) => {
    onInput?.(input);
    terminal.text = inline(terminal.text);
  };
  const models = await listPickerModels(
    { terminal, submit: () => Promise.resolve() },
    claudeModelPicker,
    2_000,
  );
  expect(models.map((model) => model.id)).toEqual(
    Array.from({ length: 7 }, (_, index) => `model${index + 1}`),
  );
  expect(state.expansions).toBe(1);
  expect(terminal.inputs.at(-1)).toBe("\u001b");
});

test.each([
  "◐ Medium effort (default) ←/→",
  "Enter to set as default",
  "Enter to set as default · s to use this session only ·",
])("C-API-55 holds the captured inline picker prefix ending at %s", (end) => {
  const frame = capturedFrame("claude-2.1.326/model-picker/collapsed");
  const position = frame.indexOf(end);
  expect(position).toBeGreaterThan(0);
  const prefix = frame.slice(0, position + end.length);
  expect(claudeModelPicker.isCandidate(prefix)).toBe(true);
  expect(claudeModelPicker.activeDialog(prefix, { opened: true })).toBeUndefined();
});
