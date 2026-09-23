/** Cancellation and close retain physical queue settlement (PRD §5.3/§5.9). */
import { expect, test, vi } from "vitest";
import { ControlQueue } from "../../src/core/control-queue/index.ts";

test.each([
  "resolve",
  "reject",
] as const)("cancelled writer %s cannot become success or release early", async (outcome) => {
  const physical = Promise.withResolvers<void>();
  const submit = vi.fn(() => physical.promise);
  const cancel = new AbortController();
  const cancelled = new Error("cancelled");
  const queue = new ControlQueue(
    submit,
    () => new Error("closed"),
    () => undefined,
  );
  queue.markReady();
  let settled = false;
  const first = queue
    .send("first", "message", undefined, {
      cancel: { signal: cancel.signal, error: () => cancelled },
    })
    .catch((error: unknown) => {
      settled = true;
      return error;
    });
  queue.markReady();
  const next = queue.send("next", "message").catch(() => undefined);
  cancel.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(submit).toHaveBeenCalledOnce();
  if (outcome === "resolve") physical.resolve();
  else physical.reject(new Error("late physical error"));
  expect(await first).toBe(cancelled);
  await next;
  expect(submit).toHaveBeenCalledTimes(2);
  queue.close();
});

test.each([
  "resolve",
  "reject",
  "cancel",
  "cancel-before-close",
] as const)("retained close keeps stopped error through %s settlement", async (race) => {
  const physical = Promise.withResolvers<void>();
  const cancel = new AbortController();
  const stopped = new Error("stopped");
  const remove = vi.spyOn(cancel.signal, "removeEventListener");
  const queue = new ControlQueue(
    () => physical.promise,
    () => stopped,
    () => undefined,
  );
  queue.markReady();
  let settled = false;
  const first = queue
    .send("first", "message", undefined, {
      settleAfterWrite: true,
      cancel: { signal: cancel.signal, error: () => new Error("cancelled") },
    })
    .catch((error: unknown) => {
      settled = true;
      return error;
    });
  if (race === "cancel-before-close") cancel.abort();
  queue.close();
  if (race === "cancel") cancel.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  if (race === "resolve") physical.resolve();
  else physical.reject(new Error("terminal disposed"));
  expect(await first).toBe(stopped);
  expect(remove).toHaveBeenCalledOnce();
});
