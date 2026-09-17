/** Picker recovery owns input through follow-up dialogs and termination (PRD §5.3, C-API-55). */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { claudeModelPicker } from "../../src/claude/model-picker.ts";
import { codexModelPicker } from "../../src/codex/model-picker.ts";
import { ControlQueue } from "../../src/core/control-queue/index.ts";
import {
  listPickerModels,
  type ModelPickerSpec,
  setPickerModel,
} from "../../src/core/models/picker.ts";
import { waitForScreen } from "../../src/core/models/tui-screen.ts";
import { PickerTransactions } from "../../src/runtime/session/picker.ts";
import {
  claudeModelCacheConfirmationOnNo,
  claudePicker,
  codexPickerCurrentIsDefault,
  codexReasoningScreen,
} from "../helpers/model-pickers.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

type Screen = { text: string };

/** `react` scripts how the fake CLI repaints after each command or key Elwood writes. */
function setup(
  spec: ModelPickerSpec,
  text: string,
  react: (input: string, screen: Screen) => void,
) {
  const screen: Screen = { text };
  const writes: string[] = [];
  const terminal = {
    snapshot: () => ({ text: screen.text }),
    sendInput: (input: string | Uint8Array) => {
      writes.push(String(input));
      react(String(input), screen);
    },
  };
  const leaked: string[] = [];
  const queue = new ControlQueue(
    (input) => {
      if (spec.isActive(screen.text)) leaked.push(String(input));
      return Promise.resolve();
    },
    () => new Error("closed"),
    () => {},
  );
  const picker = new PickerTransactions({
    terminal,
    controlQueue: queue,
    blocked: () => false,
    submitDirect: (command) => {
      writes.push(command);
      react(command, screen);
      return Promise.resolve();
    },
  });
  queue.markReady();
  return { screen, writes, leaked, queue, picker };
}

test.each([
  ["Codex reasoning", codexModelPicker, codexPickerCurrentIsDefault, "\r", codexReasoningScreen],
  ["Claude cache-warning", claudeModelPicker, claudePicker, "s", claudeModelCacheConfirmationOnNo],
] as const)("C-API-55 a %s dialog opening after the deadline is cancelled before input is released", async (_name, spec, initial, applyKey, followUp) => {
  // The apply key closes the first stage; the CLI paints the second one late.
  const { screen, writes, leaked, queue, picker } = setup(spec, "", (_input, shown) => {
    shown.text = "";
  });
  const failed = expect(
    picker.run("set_model", spec, 50, (io) => {
      screen.text = initial;
      return spec.apply(io, 5000);
    }),
  ).rejects.toMatchObject({ code: "model_automation_failed" });
  setTimeout(() => {
    screen.text = followUp;
  }, 300);
  await vi.advanceTimersByTimeAsync(350);
  const message = queue.send("hello", "message");
  await vi.advanceTimersByTimeAsync(1000);
  await Promise.all([failed, message]);
  expect(leaked).toEqual([]);
  expect(writes).toEqual([applyKey, ""]);
  expect(picker.blocksInput()).toBe(false);
  queue.close();
});

test("C-API-55 terminating during recovery prevents the cleanup Escape", async () => {
  const { screen, writes, queue, picker } = setup(claudeModelPicker, "❯ ", () => {});
  const failed = picker
    .run("set_model", claudeModelPicker, 50, async (io) => {
      await io.submit("/model", new AbortController().signal);
      await waitForScreen(io.terminal, claudeModelPicker.isOpen, 5000, "picker");
    })
    .catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(200);
  queue.close();
  screen.text = claudePicker;
  await vi.advanceTimersByTimeAsync(1500);
  expect(await failed).toBeInstanceOf(Error);
  expect(writes).toEqual(["/model"]);
});

test("C-API-55 a cancellation already written by the operation is not repeated", async () => {
  // The CLI takes 200ms to repaint after Escape; the picker is still on screen at recovery.
  const { writes, queue, picker } = setup(claudeModelPicker, "❯ ", (input, shown) => {
    if (input === "/model") shown.text = claudePicker;
    if (input === "")
      setTimeout(() => {
        shown.text = "❯ ";
      }, 200);
  });
  const failed = expect(
    picker.run("set_model", claudeModelPicker, 5000, (io) =>
      setPickerModel(io, claudeModelPicker, "no-such-model", 5000),
    ),
  ).rejects.toMatchObject({ code: "model_automation_failed" });
  await vi.advanceTimersByTimeAsync(1500);
  await failed;
  expect(writes).toEqual(["/model", ""]);
  expect(picker.blocksInput()).toBe(false);
  queue.close();
});

test("C-API-55 picker text already on screen is never driven, cancelled, or held on", async () => {
  // A transcript quoting the picker above an idle composer: no dialog here is Elwood's.
  const stale = `${claudePicker}\n\n❯ `;
  const { writes, queue, picker } = setup(claudeModelPicker, stale, () => {});
  const failed = expect(
    picker.run("list_models", claudeModelPicker, 300, (io) =>
      listPickerModels(io, claudeModelPicker, 300),
    ),
  ).rejects.toMatchObject({
    code: "model_automation_failed",
    message: expect.stringContaining("already visible"),
  });
  await vi.advanceTimersByTimeAsync(1500);
  await failed;
  expect(writes).toEqual([]);
  expect(picker.blocksInput()).toBe(false);
  queue.close();
});
