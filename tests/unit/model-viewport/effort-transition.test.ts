/** Highlighting a model without effort support preserves navigation (C-API-24). */
import { expect, test } from "vitest";
import { claudeModelPicker } from "../../../src/claude/model-picker.ts";
import { listPickerModels, setPickerModel } from "../../../src/core/models/picker.ts";
import { scripted } from "../scripted-terminal.ts";

// A success-path timeout, as in the other picker tests. Each call ends with a close wait of
// five clear readings 40 ms apart, so a timeout near that minimum fails whenever a loaded
// machine delays timers; success returns as soon as the picker closes, so a generous timeout
// costs nothing. Four calls at 2 s stay inside Vitest's 15 s test timeout.
const pickerTimeoutMs = 2_000;

test.each([
  "inline",
  "split",
] as const)("C-API-24 switches across unsupported effort with a %s control", async (layout) => {
  const labels = ["Default", "Opus 5.5", "Haiku 4.5"];
  let cursor = 1;
  let current = 1;
  const render = () =>
    [
      "Select model",
      ...labels.map(
        (label, index) =>
          `${cursor === index ? "❯" : " "} ${index + 1}. ${label}${index === current ? " ✔" : ""}${index === 0 ? " (recommended)" : ""}  Model description`,
      ),
      "",
      cursor === 2
        ? "○ Effort not supported for Haiku 4.5"
        : `◐ Medium effort (default)${layout === "inline" ? " ←/→ to adjust" : ""}`,
      "",
      "Enter to set as default · s to use this session only · Esc to cancel",
    ].join("\n");
  const terminal = scripted(render());
  const io = {
    terminal,
    submit: () => {
      terminal.text = render();
      return Promise.resolve();
    },
  };
  terminal.onInput = (input) => {
    if (input === "s") current = cursor;
    if (input === "s" || input === "\u001b") {
      terminal.text = "❯ ";
      return;
    }
    cursor += input === "\u001b[B" ? 1 : -1;
    terminal.text = render();
  };
  await setPickerModel(io, claudeModelPicker, "CLAUDE-HAIKU-4-5", pickerTimeoutMs);
  const models = await listPickerModels(io, claudeModelPicker, pickerTimeoutMs);
  expect(models).toHaveLength(3);
  expect(models.find((model) => model.isCurrent)?.id).toBe("claude-haiku-4-5");
  expect(models.find((model) => model.isDefault)?.id).toBe("default");
  await setPickerModel(io, claudeModelPicker, "opus 5.5", pickerTimeoutMs);
  expect(
    (await listPickerModels(io, claudeModelPicker, pickerTimeoutMs)).find(
      (model) => model.isCurrent,
    )?.id,
  ).toBe("claude-opus-5-5");
});
