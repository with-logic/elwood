/** A native viewport walk waits for cursor/count evidence and respects takeover (C-API-23/24). */
import { expect, test } from "vitest";
import { claudeModelPicker } from "../../../src/claude/model-picker.ts";
import { codexModelPicker } from "../../../src/codex/model-picker.ts";
import { listPickerModels, setPickerModel } from "../../../src/core/models/picker.ts";
import { claudePicker } from "../../helpers/model-pickers.ts";
import { viewportTerminal } from "./terminal.ts";

const submit = () => Promise.resolve();

test.each([
  "claude",
  "codex",
] as const)("C-API-24 %s diagnoses a missing navigation cursor", async (agent) => {
  const { terminal } = viewportTerminal(agent);
  terminal.text = terminal.text.replace(agent === "claude" ? "❯" : "›", " ");
  const spec = agent === "claude" ? claudeModelPicker : codexModelPicker;
  await expect(listPickerModels({ terminal, submit }, spec, 200)).rejects.toMatchObject({
    message: "Could not locate the picker cursor.",
  });
  expect(terminal.inputs).toEqual([]);
});

test("C-API-23 a cursor that never moves reaches the operation deadline", async () => {
  const { terminal } = viewportTerminal("codex");
  terminal.onInput = () => {};
  await expect(listPickerModels({ terminal, submit }, codexModelPicker, 30)).rejects.toMatchObject({
    code: "model_automation_failed",
  });
  expect(terminal.inputs).toEqual(["\u001b[B"]);
});

test.each([
  "foreign",
  "legacy",
  "count",
] as const)("C-API-23 waits out a %s repaint", async (kind) => {
  const { terminal, state, render } = viewportTerminal("claude");
  const onInput = terminal.onInput;
  let repainted = false;
  terminal.onInput = (input) => {
    onInput?.(input);
    if (repainted || input !== "\u001b[B" || (kind === "count" && !state.expanded)) return;
    repainted = true;
    terminal.text =
      kind === "foreign"
        ? "Do you trust this folder?"
        : kind === "legacy"
          ? claudePicker
          : terminal.text.replace(
              /↓ (\d+) more/,
              (_match, count: string) => `↓ ${Number(count) + 1} more`,
            );
    setTimeout(() => {
      terminal.text = render();
    }, 20);
  };
  const models = await listPickerModels({ terminal, submit }, claudeModelPicker, 2_000);
  expect(models).toHaveLength(7);
  expect(repainted).toBe(true);
});

test("C-API-24 takeover before the disclosure Enter cannot persist another selection", async () => {
  const { terminal, state } = viewportTerminal("claude");
  terminal.settled = () => {
    if (state.cursor === 2 && !state.expanded) terminal.text = "Do you trust this folder?";
    return Promise.resolve();
  };
  await expect(
    listPickerModels({ terminal, submit }, claudeModelPicker, 200),
  ).rejects.toMatchObject({ code: "model_automation_failed" });
  expect(terminal.inputs).not.toContain("\r");
});

test("C-API-24 a modern selection with no highlighted item fails before apply", async () => {
  const { terminal } = viewportTerminal("claude");
  terminal.text = terminal.text.replace("❯", " ");
  await expect(
    setPickerModel({ terminal, submit }, claudeModelPicker, "model1", 200),
  ).rejects.toMatchObject({ message: "Could not locate the picker cursor." });
  expect(terminal.inputs).toEqual([]);
});
