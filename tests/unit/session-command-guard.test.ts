/** Command dialog holds and cancellation at the actual queue boundary (C-API-23/24/37). */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ControlQueue } from "../../src/core/control-queue/index.ts";
import { writeQueuedInput } from "../../src/core/input/index.ts";
import { openCommandScreen } from "../../src/core/models/tui-screen.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function harness() {
  const writes: string[] = [];
  const state = { blocked: true, text: "permission" };
  const terminal = {
    sendInput: (value: string | Uint8Array) => {
      writes.push(String(value));
    },
    snapshot: () => ({ text: state.text }),
  };
  const guard = { snapshot: () => state.text, staged: () => false, blocked: () => state.blocked };
  const queue = new ControlQueue(
    (input, mode, signal) => writeQueuedInput(terminal, input, mode, guard, signal),
    () => new Error("closed"),
    () => {},
  );
  return { writes, state, terminal, guard, queue };
}
test.each([
  "list_models",
  "set_model",
] as const)("C-API-37 %s cannot write into a pending decision", async (kind) => {
  const h = harness();
  const pending = h.queue.send("/model", kind);
  await vi.advanceTimersByTimeAsync(300);
  expect(h.writes).toEqual([]);
  h.state.blocked = false;
  await vi.advanceTimersByTimeAsync(200);
  await pending;
  expect(h.writes).toEqual(["/model", "\r"]);
  h.queue.close();
});
test("C-API-37 a dialog appearing after command text holds Enter until it clears", async () => {
  const h = harness();
  h.state.blocked = false;
  const pending = h.queue.send("/model", "list_models");
  expect(h.writes).toEqual(["/model"]);
  h.state.blocked = true;
  await vi.advanceTimersByTimeAsync(300);
  expect(h.writes).toEqual(["/model"]);
  h.state.blocked = false;
  await vi.advanceTimersByTimeAsync(50);
  await pending;
  expect(h.writes).toEqual(["/model", "\r"]);
  h.queue.close();
});
test.each([
  true,
  false,
])("C-API-23 timeout cancels held command (initially blocked=%s)", async (initiallyBlocked) => {
  const h = harness();
  h.state.blocked = initiallyBlocked;
  const result = openCommandScreen({
    terminal: h.terminal,
    isOpen: () => false,
    label: "picker",
    timeoutMs: 250,
    submit: (signal) =>
      h.queue.send("/model", "list_models", undefined, {
        cancel: { signal, error: () => new Error("cancelled") },
      }),
  });
  const check = expect(result).rejects.toMatchObject({ code: "model_automation_failed" });
  h.state.blocked = true;
  await vi.advanceTimersByTimeAsync(400);
  await check;
  h.state.blocked = false;
  await vi.advanceTimersByTimeAsync(2000);
  expect(h.writes).toEqual(initiallyBlocked ? [] : ["/model"]);
  h.queue.close();
});
test("C-API-37 terminal failure propagates without a retry or cleanup Enter", async () => {
  const result = writeQueuedInput(
    {
      sendInput: () => {
        throw new Error("closed");
      },
    },
    "/model",
    "command",
  );
  await expect(result).rejects.toThrow("closed");
  const result2 = writeQueuedInput(
    {
      sendInput: (input) => {
        if (input === "\r") throw new Error("enter failed");
      },
    },
    "/model",
    "command",
  );
  const check = expect(result2).rejects.toThrow("enter failed");
  await vi.advanceTimersByTimeAsync(150);
  await check;
});

test("C-API-37 cancelling a command in a live unblocked composer clears its staged text", async () => {
  const h = harness();
  h.state.blocked = false;
  const controller = new AbortController();
  const pending = h.queue.send("/model", "list_models", undefined, {
    cancel: { signal: controller.signal, error: () => new Error("caller cancelled") },
  });
  const rejected = expect(pending).rejects.toThrow("caller cancelled");
  expect(h.writes).toEqual(["/model"]);
  controller.abort();
  await vi.advanceTimersByTimeAsync(500);
  await rejected;
  expect(h.writes).toEqual(["/model", "\u0015\u000b"]);
  expect(h.state.blocked).toBe(false);
  h.queue.close();
});
