/** Compact's recovery Enter is a queued write that respects model-picker ownership (C-API-22, C-API-55). */
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

const escapeKey = String.fromCharCode(27);
type Hooks = ElwoodCommonEventMap & { readonly hook: { readonly hook_event_name: string } };

/**
 * A fake Claude whose slash popup swallows the Enter that submits `/compact`, so only
 * the recovery Enter starts compaction. `/model` opens a picker that Escape closes after
 * `closeMs`; `closeMs` undefined models a CLI that ignores Escape.
 */
function setup(closeMs: number | undefined) {
  const emitter = new TypedEmitter<Hooks>();
  const state = { screen: "❯ ", staged: "", swallowed: false, blocked: false };
  const writes: { input: string; inPicker: boolean }[] = [];
  const terminal = {
    snapshot: () => ({ text: state.screen }),
    sendInput(data: string | Uint8Array) {
      const input = String(data);
      const inPicker = state.screen.includes("Select model");
      writes.push({ input, inPicker });
      if (input.startsWith("/")) state.staged = input;
      if (input === escapeKey && closeMs !== undefined)
        setTimeout(() => {
          state.screen = "❯ ";
        }, closeMs);
      if (input !== "\r" || inPicker) return;
      if (state.staged === "/model") state.screen = claudePicker;
      else if (state.swallowed) emitter.emit("hook", { hook_event_name: "PostCompact" });
      else state.swallowed = true;
      state.staged = "";
    },
  };
  // As in a session: queued writes hold on blocking dialogs and on a surviving model dialog.
  const guard = {
    snapshot: () => state.screen,
    staged: () => false,
    blocked: () => state.blocked || commands.blocksInput(),
  };
  const queue = new ControlQueue(
    (input, mode, signal) => writeQueuedInput(terminal, input, mode, guard, signal),
    () => new Error("closed"),
    () => {},
  );
  queue.markReady();
  const commands: CommandSurface = new CommandSurface({
    terminal,
    statusEvents: emitter,
    status: () => "ready",
    everReady: () => true,
    blocked: () => state.blocked,
    picker: () => claudeModelPicker,
    controlQueue: queue,
    submitDirect: (input, signal) =>
      writeQueuedInput(terminal, input, "command", undefined, signal),
  });
  const entersInPicker = () => writes.filter((write) => write.input === "\r" && write.inPicker);
  return { emitter, state, writes, queue, commands, entersInPicker };
}

test("C-API-22 the recovery Enter still starts a compaction whose Enter was swallowed", async () => {
  const { queue, commands, writes } = setup(200);
  const compact = commands.compact({ timeoutMs: 10_000 });
  await vi.advanceTimersByTimeAsync(3500);
  await compact;
  expect(writes.map((write) => write.input)).toEqual(["/compact", "\r", "\r"]);
  queue.close();
});

test("C-API-55 the recovery Enter waits out a model picker instead of being lost", async () => {
  // The picker is open from ~1s to ~5s, across the 3s recovery deadline.
  const { queue, commands, entersInPicker } = setup(4000);
  const compact = commands.compact({ timeoutMs: 10_000 });
  const models = commands.listModels({ timeoutMs: 8000 });
  await vi.advanceTimersByTimeAsync(3500);
  expect(entersInPicker()).toEqual([]);
  await vi.advanceTimersByTimeAsync(3000);
  // Once the picker transaction releases the queue, the deferred Enter starts compaction.
  await Promise.all([compact, models]);
  expect(entersInPicker()).toEqual([]);
  queue.close();
});

test("C-API-55 a recovery Enter still queued when compaction settles is dropped", async () => {
  const { emitter, queue, commands, writes } = setup(4000);
  const compact = commands.compact({ timeoutMs: 10_000 });
  const models = commands.listModels({ timeoutMs: 8000 });
  await vi.advanceTimersByTimeAsync(3500);
  emitter.emit("hook", { hook_event_name: "PostCompact" });
  await compact;
  const before = writes.length;
  await vi.advanceTimersByTimeAsync(3000);
  await models;
  expect(writes.slice(before).map((write) => write.input)).toEqual([]);
  queue.close();
});

test.each([
  ["a blocking dialog", true],
  ["a model dialog left on screen", false],
] as const)("C-API-55 the recovery Enter is withheld from %s", async (_name, dialogBlocks) => {
  const { state, queue, commands, entersInPicker, writes } = setup(undefined);
  const compact = commands.compact({ timeoutMs: 6000 }).catch((error) => error.code);
  // The unknown model fails; this CLI ignores Escape, so the picker outlives cleanup.
  const failed = commands.setModel("no-such-model", { timeoutMs: 8000 }).catch(() => "failed");
  await vi.advanceTimersByTimeAsync(2500);
  expect(await failed).toBe("failed");
  expect(commands.blocksInput()).toBe(true);
  if (dialogBlocks) state.screen = "Do you want to proceed?";
  state.blocked = dialogBlocks;
  await vi.advanceTimersByTimeAsync(4000);
  expect(await compact).toBe("compact_failed");
  // Enter on the surviving picker would save the highlighted model as the user default.
  expect(entersInPicker()).toEqual([]);
  expect(writes.filter((write) => write.input === "\r")).toHaveLength(2);
  queue.close();
});
