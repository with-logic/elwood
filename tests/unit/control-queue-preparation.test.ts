/** Queue preparation must succeed before publishing or consuming a caller turn (C-API-37/56). */
import { expect, test, vi } from "vitest";
import { ControlQueue } from "../../src/core/control-queue/index.ts";

test("C-API-37/56 failed preparation preserves readiness and publishes no caller submission", async () => {
  const submit = vi.fn(() => Promise.resolve());
  const caller = vi.fn();
  let fail = true;
  const queue = new ControlQueue(
    submit,
    () => new Error("closed"),
    caller,
    undefined,
    undefined,
    (work) => (fail ? Promise.reject(new Error("preparation failed")) : work()),
  );
  queue.markReady();
  try {
    await expect(queue.send("first", "message")).rejects.toThrow("preparation failed");
    expect(submit).not.toHaveBeenCalled();
    expect(caller).not.toHaveBeenCalled();
    fail = false;
    await queue.send("next", "message");
    expect(submit).toHaveBeenCalledOnce();
    expect(caller).toHaveBeenCalledExactlyOnceWith({ kind: "caller" });
  } finally {
    queue.close();
  }
});
