/** Model transactions retain queue ownership through recovery (PRD §5.3, C-API-55). */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { claudeModelPicker } from "../../src/claude/model-picker.ts";
import { codexModelPicker } from "../../src/codex/model-picker.ts";
import { ControlQueue } from "../../src/core/control-queue/index.ts";
import { delay } from "../../src/core/delay.ts";
import { waitForScreen } from "../../src/core/models/tui-screen.ts";
import { PickerTransactions } from "../../src/runtime/session/picker.ts";
import {
  claudeHookSwitchConfirmation,
  claudeModelCacheConfirmationOnNo,
  claudePicker,
  codexPickerCurrentIsDefault,
  codexReasoningScreen,
} from "../helpers/model-pickers.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(text = "❯ ") {
  const state = { text, cancelWorks: true };
  const writes: string[] = [];
  const terminal = {
    snapshot: () => ({ text: state.text }),
    sendInput: (input: string | Uint8Array) => {
      writes.push(String(input));
      if (input === "\u001b" && state.cancelWorks) state.text = "❯ ";
    },
  };
  const leaked: string[] = [];
  const queue = new ControlQueue(
    (input) => {
      if (claudeModelPicker.isActive(state.text)) leaked.push(String(input));
      return Promise.resolve();
    },
    () => new Error("closed"),
    () => {},
  );
  const picker = new PickerTransactions({
    terminal,
    controlQueue: queue,
    blocked: () => false,
    submitDirect: (command, signal) => {
      signal.throwIfAborted();
      writes.push(command);
      return Promise.resolve();
    },
  });
  return { state, writes, leaked, queue, picker };
}

test("C-API-55 queue wait consumes the deadline without opening a picker", async () => {
  const { queue, picker, writes } = setup();
  const preceding = queue.runExclusive("list_models", () => delay(100));
  const work = vi.fn(async () => 1);
  const failed = expect(
    picker.run("list_models", claudeModelPicker, 50, work),
  ).rejects.toMatchObject({ code: "model_automation_failed" });
  await vi.advanceTimersByTimeAsync(50);
  await failed;
  queue.markReady();
  expect(work).not.toHaveBeenCalled();
  expect(writes).toEqual([]);
  await vi.advanceTimersByTimeAsync(50);
  await preceding;
  queue.close();
});

test.each([
  "snapshot",
  "sendInput",
] as const)("C-API-55 deadline aborts active %s and closes the owned dialog", async (method) => {
  const { queue, picker, state, writes } = setup();
  queue.markReady();
  const failed = expect(
    picker.run("set_model", claudeModelPicker, 50, async (io) => {
      state.text = claudePicker;
      await delay(100);
      return method === "snapshot" ? io.terminal.snapshot() : io.terminal.sendInput("s");
    }),
  ).rejects.toMatchObject({ code: "model_automation_failed" });
  await vi.advanceTimersByTimeAsync(150);
  await failed;
  expect(writes).toEqual(["\u001b"]);
  expect(picker.blocksInput()).toBe(false);
  queue.close();
});

test("C-API-55 failed cancellation holds input until manual dismissal", async () => {
  const { queue, picker, state, writes } = setup();
  state.cancelWorks = false;
  queue.markReady();
  const error = new Error("parse failed");
  const failed = expect(
    picker.run("set_model", claudeModelPicker, 2000, () => {
      state.text = claudePicker;
      return Promise.reject(error);
    }),
  ).rejects.toBe(error);
  await vi.advanceTimersByTimeAsync(1000);
  await failed;
  expect(writes).toEqual(["\u001b"]);
  expect(picker.blocksInput()).toBe(true);
  state.text = "❯ ";
  expect(picker.blocksInput()).toBe(false);
  expect(picker.blocksInput()).toBe(false);
  queue.close();
});

test("C-API-55 a dialog opening just after the deadline is cancelled before input is released", async () => {
  const { queue, picker, state, writes, leaked } = setup();
  queue.markReady();
  const failed = expect(
    picker.run("set_model", claudeModelPicker, 50, async (io) => {
      await io.submit("/model", new AbortController().signal);
      await waitForScreen(io.terminal, claudeModelPicker.isOpen, 5000, "picker");
    }),
  ).rejects.toMatchObject({ code: "model_automation_failed" });
  // The CLI acts on the already-submitted command only after the operation timed out.
  setTimeout(() => {
    state.text = claudePicker;
  }, 300);
  await vi.advanceTimersByTimeAsync(350);
  const message = queue.send("hello", "message");
  await vi.advanceTimersByTimeAsync(1000);
  await Promise.all([failed, message]);
  expect(leaked).toEqual([]);
  expect(writes).toEqual(["/model", "\u001b"]);
  expect(picker.blocksInput()).toBe(false);
  queue.close();
});

test("C-API-55 a submitted command whose dialog never appears releases input after the bound", async () => {
  const { queue, picker, writes } = setup();
  queue.markReady();
  const failed = expect(
    picker.run("list_models", claudeModelPicker, 50, async (io) => {
      await io.submit("/model", new AbortController().signal);
      await waitForScreen(io.terminal, claudeModelPicker.isOpen, 5000, "picker");
    }),
  ).rejects.toMatchObject({ code: "model_automation_failed" });
  const message = queue.send("hello", "message");
  await vi.advanceTimersByTimeAsync(1100);
  await Promise.all([failed, message]);
  expect(writes).toEqual(["/model"]);
  expect(picker.blocksInput()).toBe(false);
  queue.close();
});

test("C-API-55 terminating during navigation aborts without cleanup writes", async () => {
  const { queue, picker, state, writes } = setup();
  queue.markReady();
  const failed = expect(
    picker.run("set_model", claudeModelPicker, 5000, async (io) => {
      await io.submit("/model", new AbortController().signal);
      state.text = claudePicker;
      await waitForScreen(io.terminal, () => false, 5000, "cursor");
    }),
  ).rejects.toThrow("closed");
  await vi.advanceTimersByTimeAsync(10);
  queue.close();
  await failed;
  await vi.advanceTimersByTimeAsync(200);
  expect(writes).toEqual(["/model"]);
});

test("C-API-55 unrelated human dialogs are left open on failure", async () => {
  const { queue, picker, writes } = setup(claudeHookSwitchConfirmation);
  queue.markReady();
  await expect(
    picker.run("set_model", claudeModelPicker, 5000, () => Promise.reject(new Error("replaced"))),
  ).rejects.toThrow("replaced");
  expect(writes).toEqual([]);
  queue.close();
});

test.each([
  [claudeModelPicker, claudePicker, true],
  [claudeModelPicker, claudeModelCacheConfirmationOnNo, true],
  [claudeModelPicker, claudeHookSwitchConfirmation, false],
  [claudeModelPicker, "❯ ", false],
  [codexModelPicker, codexPickerCurrentIsDefault, true],
  [codexModelPicker, codexReasoningScreen, true],
  [codexModelPicker, "› ", false],
] as const)("C-API-55 recognizes only owned cancellation screens %#", (spec, text, active) => {
  expect(spec.isActive(text)).toBe(active);
});
