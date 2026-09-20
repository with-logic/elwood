/** Picker authority and opening waits belong to the same operation (C-API-55). */
import { afterEach, expect, test, vi } from "vitest";
import { codexModelPicker } from "../../src/codex/model-picker.ts";
import { ControlQueue } from "../../src/core/control-queue/index.ts";
import { openCommandScreen } from "../../src/core/models/tui-screen.ts";
import { PickerTransactions } from "../../src/runtime/session/picker.ts";
import { codexPickerCurrentIsDefault } from "../helpers/model-pickers.ts";

afterEach(() => vi.useRealTimers());

test("C-API-55 a failed model command never authorizes cleanup of a foreign picker", async () => {
  vi.useFakeTimers();
  let text = "› ";
  const writes: string[] = [];
  const failedWrite = new Error("write failed");
  const queue = new ControlQueue(
    () => Promise.resolve(),
    () => new Error("closed"),
    () => {},
  );
  queue.markReady();
  const picker = new PickerTransactions({
    controlQueue: queue,
    terminal: {
      snapshot: () => ({ text }),
      sendInput: (input) => {
        writes.push(String(input));
      },
    },
    blocked: () => false,
    picker: () => codexModelPicker,
    submitDirect: () => {
      text = codexPickerCurrentIsDefault;
      return Promise.reject(failedWrite);
    },
  });
  const result = picker
    .run("set_model", codexModelPicker, 5000, (io) =>
      io.submit("/model", new AbortController().signal),
    )
    .catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(1100);
  expect(await result).toBe(failedWrite);
  expect(writes).toEqual([]);
  expect(picker.blocksInput()).toBe(false);
  expect(picker.foreignDialogVisible()).toBe(true);
  queue.close();
});

test("C-API-55 delayed picker opening honors the operation signal instead of a fresh phase budget", async () => {
  vi.useFakeTimers();
  const deadline = new AbortController();
  const expired = new Error("operation expired");
  let failure: unknown;
  const result = openCommandScreen({
    terminal: { snapshot: () => ({ text: "› " }), sendInput: () => {} },
    submit: () => new Promise<void>((resolve) => setTimeout(resolve, 200)),
    isOpen: () => false,
    timeoutMs: 5000,
    label: "model picker",
    signal: deadline.signal,
  }).catch((error: unknown) => {
    failure = error;
  });
  try {
    await vi.advanceTimersByTimeAsync(250);
    deadline.abort(expired);
    await vi.advanceTimersByTimeAsync(100);
    expect(failure).toBe(expired);
  } finally {
    await vi.runAllTimersAsync();
    await result;
  }
});
