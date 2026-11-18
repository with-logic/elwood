/** Counted repaints withhold navigation until the known total returns (C-API-23). */
import { expect, onTestFinished, test, vi } from "vitest";
import { claudeModelPicker } from "../../../src/claude/model-picker.ts";
import { listPickerModels } from "../../../src/core/models/picker.ts";
import { viewportTerminal } from "./terminal.ts";

test("C-API-23 sends no further keys while an expanded viewport count is inconsistent", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  onTestFinished(() => {
    controller.abort();
    vi.useRealTimers();
  });
  const { terminal, render } = viewportTerminal("claude", { expanded: true });
  const onInput = terminal.onInput;
  let changed = false;
  terminal.onInput = (input) => {
    onInput?.(input);
    if (changed || input !== "\u001b[B") return;
    changed = true;
    terminal.text = terminal.text.replace(
      /↓ (\d+) more/,
      (_match, count: string) => `↓ ${Number(count) + 1} more`,
    );
  };
  const pending = listPickerModels(
    { terminal, submit: () => Promise.resolve(), signal: controller.signal },
    claudeModelPicker,
    2_000,
  );
  void pending.catch(() => {});
  await vi.advanceTimersByTimeAsync(50);
  expect(changed).toBe(true);
  expect(terminal.inputs).toEqual(["\u001b[B"]);
  terminal.text = render();
  await vi.advanceTimersByTimeAsync(500);
  expect((await pending).map((model) => model.id)).toEqual(
    Array.from({ length: 7 }, (_, index) => `model${index + 1}`),
  );
  expect(terminal.inputs.at(-1)).toBe("\u001b");
});
