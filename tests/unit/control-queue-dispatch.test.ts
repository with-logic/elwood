/** Physical caller submission reconciles status without repeating loop intent (PRD §5.3). */
import { expect, test, vi } from "vitest";
import { ControlQueue, type ControlSubmitter } from "../../src/core/control-queue/index.ts";

test("C-ATTN-02 only caller turns report physical dispatch, independently of turn intent", async () => {
  const intent = vi.fn();
  const dispatched = vi.fn();
  const submit = vi.fn<ControlSubmitter>((_input, _mode, _signal, onSubmitted) => {
    onSubmitted?.();
    return Promise.resolve();
  });
  const queue = new ControlQueue(
    submit,
    () => new Error("closed"),
    intent,
    () => false,
    dispatched,
  );
  queue.markReady();
  await queue.send("caller", "message");
  expect(intent).toHaveBeenCalledExactlyOnceWith({ kind: "caller" });
  expect(dispatched).toHaveBeenCalledTimes(1);
  queue.markReady();
  await queue.send("loop", "message", undefined, { origin: { kind: "loop", loopId: "l1" } });
  // The loop delivery consumes its commit before reentrant running observers.
  await Promise.resolve();
  expect(intent).toHaveBeenLastCalledWith({ kind: "loop", loopId: "l1" });
  expect(intent).toHaveBeenCalledTimes(2);
  expect(dispatched).toHaveBeenCalledTimes(1);
  queue.markReady();
  await queue.send("/compact", "compact");
  expect(intent).toHaveBeenCalledTimes(2);
  expect(dispatched).toHaveBeenCalledTimes(1);
  queue.close();
});

test("C-ATTN-02 a physical status observer failure cannot reject an already-submitted prompt", async () => {
  const queue = new ControlQueue(
    (_input, _mode, _signal, onSubmitted) => {
      onSubmitted?.();
      return Promise.resolve();
    },
    () => new Error("closed"),
    () => undefined,
    () => false,
    () => {
      throw new Error("status observer");
    },
  );
  await expect(queue.send("prompt", "prompt")).resolves.toBeUndefined();
  queue.close();
});
