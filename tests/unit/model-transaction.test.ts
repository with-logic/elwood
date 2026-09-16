/** Exclusive model-picker ownership through cancellation (PRD §5.3, C-API-23/24). */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { claudeModelPicker } from "../../src/claude/model-picker.ts";
import type { ElwoodCommonEventMap } from "../../src/core/agent-session.ts";
import { ControlQueue } from "../../src/core/control-queue/index.ts";
import { writeQueuedInput } from "../../src/core/input/index.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";
import { CommandSurface } from "../../src/runtime/session/commands.ts";
import { claudePicker } from "../helpers/model-pickers.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("C-API-23 overlapping lists and a message wait for each picker to close", async () => {
  let screen = "❯ ";
  const writes: { input: string; inPicker: boolean }[] = [];
  const terminal = {
    snapshot: () => ({ text: screen }),
    sendInput(input: string | Uint8Array) {
      writes.push({ input: String(input), inPicker: screen.includes("Select model") });
      if (input === "\r") screen = claudePicker;
      if (input === "\u001b")
        setTimeout(() => {
          screen = "❯ ";
        }, 200);
    },
  };
  const queue = new ControlQueue(
    (input, mode, signal) => writeQueuedInput(terminal, input, mode, undefined, signal),
    () => new Error("closed"),
    () => {},
  );
  queue.markReady();
  const deps = {
    terminal,
    statusEvents: new TypedEmitter<ElwoodCommonEventMap>(),
    status: () => "ready" as const,
    everReady: () => true,
    blocked: () => false,
    picker: () => claudeModelPicker,
    controlQueue: queue,
    submitDirect: (command: string, signal: AbortSignal) =>
      writeQueuedInput(terminal, command, "command", undefined, signal),
  };
  const commands = new CommandSurface(deps);
  const a = commands.listModels({ timeoutMs: 3000 });
  const b = commands.listModels({ timeoutMs: 3000 });
  const message = queue.send("hello", "message");
  const done = Promise.all([a, b, message]);
  await vi.advanceTimersByTimeAsync(2500);
  await done;
  expect(writes.filter((write) => write.input === "/model")).toEqual([
    { input: "/model", inPicker: false },
    { input: "/model", inPicker: false },
  ]);
  expect(writes.find((write) => write.input.includes("hello"))?.inPicker).toBe(false);
  queue.close();
});
