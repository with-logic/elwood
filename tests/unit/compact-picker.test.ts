/** Stale compact recovery must respect model-picker ownership (PRD §5.3, C-API-55). */
import { afterEach, expect, test, vi } from "vitest";
import { claudeModelPicker } from "../../src/claude/model-picker.ts";
import type { ElwoodCommonEventMap } from "../../src/core/agent-session.ts";
import { ControlQueue } from "../../src/core/control-queue/index.ts";
import { writeQueuedInput } from "../../src/core/input/index.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";
import { CommandSurface } from "../../src/runtime/session/commands.ts";
import { claudePicker } from "../helpers/model-pickers.ts";

afterEach(() => vi.useRealTimers());

test("C-API-22 compact still nudges an unobstructed composer", async () => {
  vi.useFakeTimers();
  const sendInput = vi.fn();
  const terminal = { snapshot: () => ({ text: "❯ " }), sendInput };
  const queue = new ControlQueue(
    (input, mode, signal) => writeQueuedInput(terminal, input, mode, undefined, signal),
    () => new Error("closed"),
    () => {},
  );
  queue.markReady();
  const emitter = new TypedEmitter<
    ElwoodCommonEventMap & { readonly hook: { readonly hook_event_name: string } }
  >();
  const commands = new CommandSurface({
    terminal,
    statusEvents: emitter,
    status: () => "ready",
    everReady: () => true,
    blocked: () => false,
    picker: () => claudeModelPicker,
    controlQueue: queue,
    submitDirect: (input, signal) =>
      writeQueuedInput(terminal, input, "command", undefined, signal),
  });
  const compact = commands.compact({ timeoutMs: 10000 });
  await vi.advanceTimersByTimeAsync(1000);
  sendInput.mockClear();
  await vi.advanceTimersByTimeAsync(2500);
  expect(sendInput).toHaveBeenCalledExactlyOnceWith("\r");
  emitter.emit("hook", { hook_event_name: "PostCompact" });
  await compact;
  queue.close();
});

test("C-API-55 an earlier compact nudge cannot confirm a later model picker", async () => {
  vi.useFakeTimers();
  let screen = "❯ ";
  let command = "";
  const writes: { input: string; inPicker: boolean }[] = [];
  const terminal = {
    snapshot: () => ({ text: screen }),
    sendInput(input: string | Uint8Array) {
      writes.push({ input: String(input), inPicker: screen.includes("Select model") });
      if (String(input).startsWith("/")) command = String(input);
      if (input === "\r" && command === "/model") screen = claudePicker;
      if (input === "\u001b")
        setTimeout(() => {
          screen = "❯ ";
        }, 4000);
    },
  };
  const queue = new ControlQueue(
    (input, mode, signal) => writeQueuedInput(terminal, input, mode, undefined, signal),
    () => new Error("closed"),
    () => {},
  );
  queue.markReady();
  const emitter = new TypedEmitter<
    ElwoodCommonEventMap & { readonly hook: { readonly hook_event_name: string } }
  >();
  const commands = new CommandSurface({
    terminal,
    statusEvents: emitter,
    status: () => "ready",
    everReady: () => true,
    blocked: () => false,
    picker: () => claudeModelPicker,
    controlQueue: queue,
    submitDirect: (input, signal) =>
      writeQueuedInput(terminal, input, "command", undefined, signal),
  });
  const compact = commands.compact({ timeoutMs: 10000 });
  const models = commands.listModels({ timeoutMs: 8000 });
  await vi.advanceTimersByTimeAsync(3500);
  expect(writes.filter((write) => write.input === "\r" && write.inPicker)).toEqual([]);
  await vi.advanceTimersByTimeAsync(1500);
  emitter.emit("hook", { hook_event_name: "PostCompact" });
  await Promise.all([compact, models]);
  queue.close();
});
