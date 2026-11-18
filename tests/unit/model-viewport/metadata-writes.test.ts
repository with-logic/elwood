/** Picker metadata must survive movement and the prewrite barrier (C-API-23/24). */
import { expect, onTestFinished, test, vi } from "vitest";
import { claudeModelPicker } from "../../../src/claude/model-picker.ts";
import { codexModelPicker } from "../../../src/codex/model-picker.ts";
import { listPickerModels } from "../../../src/core/models/picker.ts";
import { viewportTerminal } from "./terminal.ts";

const wrongCount = (text: string) =>
  text.replace(/↓ (\d+) more/, (_match, count: string) => `↓ ${Number(count) + 1} more`);

test.each([
  "collapsed movement",
  "prewrite count",
  "prewrite cursor",
  "prewrite end",
  "prewrite legacy",
] as const)("C-API-23 withholds input on inconsistent %s metadata", async (kind) => {
  vi.useFakeTimers();
  const controller = new AbortController();
  onTestFinished(() => {
    controller.abort();
    vi.useRealTimers();
  });
  const codex = kind === "prewrite cursor" || kind === "prewrite end" || kind === "prewrite legacy";
  const { terminal, state, render } = viewportTerminal(
    codex ? "codex" : "claude",
    codex
      ? { cursor: kind === "prewrite end" ? 8 : kind === "prewrite legacy" ? 7 : 0 }
      : { expanded: kind !== "collapsed movement", primary: kind === "collapsed movement" ? 2 : 5 },
  );
  const openingCursor = state.cursor;
  const onInput = terminal.onInput;
  let changed = false;
  terminal.onInput = (input) => {
    onInput?.(input);
    if (kind !== "collapsed movement" || changed || input !== "\u001b[B") return;
    changed = true;
    terminal.text = terminal.text.replace(/(More models)\n/, "$1\n↓ 1 more\n");
  };
  terminal.settled = () => {
    if (!changed && kind !== "collapsed movement") {
      changed = true;
      if (kind === "prewrite cursor") {
        state.cursor += 1;
        terminal.text = render();
      } else {
        terminal.text =
          kind === "prewrite end" || kind === "prewrite legacy"
            ? terminal.text.replace(/\n↓\n/, "\n\n")
            : wrongCount(terminal.text);
      }
    }
    return Promise.resolve();
  };
  const pending = listPickerModels(
    { terminal, submit: () => Promise.resolve(), signal: controller.signal },
    codex ? codexModelPicker : claudeModelPicker,
    2_000,
  );
  void pending.catch(() => {});
  await vi.advanceTimersByTimeAsync(50);
  expect(changed).toBe(true);
  expect(terminal.inputs).toEqual(kind === "collapsed movement" ? ["\u001b[B"] : []);
  if (kind === "prewrite cursor") state.cursor = openingCursor;
  terminal.text = render();
  await vi.advanceTimersByTimeAsync(1_000);
  expect((await pending).map((model) => model.id)).toEqual(
    Array.from({ length: codex ? 10 : 7 }, (_, index) =>
      codex ? `model${index + 1}` : `claude-fixture-${index + 1}`,
    ),
  );
  expect(terminal.inputs.at(-1)).toBe("\u001b");
});
