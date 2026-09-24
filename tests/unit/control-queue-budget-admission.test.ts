/** Exact admission limits reject before scanning text or preparing input (C-API-58). */
import { expect, test, vi } from "vitest";
import { inputQueueLimits } from "../../src/core/control-queue/budget.ts";
import { ControlQueue } from "../../src/core/control-queue/index.ts";

test("C-API-58 pins the public operation and UTF-8 byte limits", () => {
  expect(inputQueueLimits).toEqual({ operations: 1_024, bytes: 8 * 1_024 * 1_024 });
});

for (const limit of ["count", "bytes"] as const) {
  test(`C-API-58 bounds suspended ${limit} before attachment or admission`, async () => {
    const submit = vi.fn(async () => undefined);
    const admit = vi.fn(() => undefined);
    const queue = new ControlQueue(
      submit,
      () => new Error("closed"),
      () => undefined,
      undefined,
      undefined,
      undefined,
      admit,
    );
    const attach = vi.fn(async () => undefined);
    const input = limit === "bytes" ? "é".repeat(4 * 1_024 * 1_024) : "";
    const count = limit === "bytes" ? 1 : 1_024;
    const waiting = Array.from({ length: count }, () =>
      queue.send(input, "message").catch((error: unknown) => error),
    );
    const byteLength = vi.spyOn(Buffer, "byteLength");
    let failure: unknown;
    // A prompt can bypass readiness, so without the cap it really would prepare admission.
    const overflow = queue.send("x", "prompt", attach).catch((error: unknown) => {
      failure = error;
    });
    const scans = byteLength.mock.calls.length;
    byteLength.mockRestore();
    try {
      await Promise.resolve();
      expect(failure).toMatchObject({ code: "input_queue_full", details: {} });
      expect(scans).toBe(limit === "count" ? 0 : 1);
      expect(admit).not.toHaveBeenCalled();
      expect(attach).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
    } finally {
      queue.close();
      await Promise.all([...waiting, overflow]);
    }
  });
}
