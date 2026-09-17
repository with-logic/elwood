/** Model transactions own the input queue until they settle (PRD §5.3, C-API-55). */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { claudeModelPicker } from "../../src/claude/model-picker.ts";
import { ControlQueue } from "../../src/core/control-queue/index.ts";
import { delay } from "../../src/core/delay.ts";
import { listPickerModels } from "../../src/core/models/picker.ts";
import { waitForScreen } from "../../src/core/models/tui-screen.ts";
import { PickerTransactions } from "../../src/runtime/session/picker.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const escapeKey = String.fromCharCode(27);

function setup() {
  const writes: string[] = [];
  const attempts = { count: 0 };
  const terminal = {
    snapshot: () => ({ text: "❯ " }),
    sendInput: (input: string | Uint8Array) => void writes.push(String(input)),
  };
  const queue = new ControlQueue(
    (input) => {
      writes.push(String(input));
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
      attempts.count += 1;
      signal.throwIfAborted();
      writes.push(command);
      return Promise.resolve();
    },
  });
  return { writes, attempts, queue, picker };
}

test("C-API-55 queue wait consumes the deadline without opening a picker", async () => {
  const { queue, picker, writes } = setup();
  const preceding = queue.runExclusive("list_models", () => delay(100));
  const work = vi.fn(async () => 1);
  const failed = expect(picker.run("list_models", 50, work)).rejects.toMatchObject({
    code: "model_automation_failed",
  });
  await vi.advanceTimersByTimeAsync(50);
  await failed;
  queue.markReady();
  expect(work).not.toHaveBeenCalled();
  expect(writes).toEqual([]);
  await vi.advanceTimersByTimeAsync(50);
  await preceding;
  queue.close();
});

test("C-API-55 a queued message is dispatched only after the transaction settles", async () => {
  const { queue, picker, writes } = setup();
  queue.markReady();
  const listed = picker.run("list_models", 5000, async (io) => {
    await io.submit("/model", new AbortController().signal);
    await delay(300);
    await io.terminal.sendInput(escapeKey);
    return "rows";
  });
  const message = queue.send("hello", "message");
  await vi.advanceTimersByTimeAsync(300);
  expect(await listed).toBe("rows");
  await message;
  expect(writes).toEqual(["/model", escapeKey, "hello"]);
  queue.close();
});

test.each([
  "snapshot",
  "sendInput",
  "submit",
] as const)("C-API-55 the deadline aborts a pending %s before it reaches the terminal", async (method) => {
  const { queue, picker, writes } = setup();
  queue.markReady();
  const failed = expect(
    picker.run("set_model", 50, async (io) => {
      await delay(100);
      if (method === "submit") return io.submit("/model", new AbortController().signal);
      return method === "snapshot" ? io.terminal.snapshot() : io.terminal.sendInput("s");
    }),
  ).rejects.toMatchObject({ code: "model_automation_failed" });
  await vi.advanceTimersByTimeAsync(150);
  await failed;
  expect(writes).toEqual([]);
  queue.close();
});

test("C-API-55 terminating during navigation aborts without further writes", async () => {
  const { queue, picker, writes } = setup();
  queue.markReady();
  const failed = expect(
    picker.run("set_model", 5000, async (io) => {
      await io.submit("/model", new AbortController().signal);
      await waitForScreen(io.terminal, () => false, 5000, "cursor");
    }),
  ).rejects.toThrow("closed");
  await vi.advanceTimersByTimeAsync(10);
  queue.close();
  await failed;
  await vi.advanceTimersByTimeAsync(200);
  expect(writes).toEqual(["/model"]);
});

test.each([
  ["the deadline", false],
  ["termination", true],
] as const)("C-API-55 the real opener stops re-submitting /model after %s", async (_name, close) => {
  // The picker never opens, so the opener would re-submit `/model` every two seconds.
  const { queue, picker, writes, attempts } = setup();
  queue.markReady();
  const failed = picker
    .run("list_models", close ? 60_000 : 50, (io) =>
      listPickerModels(io, claudeModelPicker, 60_000),
    )
    .catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(100);
  if (close) queue.close();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await failed).toBeInstanceOf(Error);
  expect(writes).toEqual(["/model"]);
  // Not even an attempt: the re-submit timer stops with the operation.
  expect(attempts.count).toBe(1);
  queue.close();
});
