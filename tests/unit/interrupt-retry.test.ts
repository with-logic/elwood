/** Claude's swallowed first Escape gets a guarded retry (PRD §5.3, C-API-38). */
import { afterEach, expect, test, vi } from "vitest";
import { sessionInterrupt } from "../../src/core/interrupt.ts";
import type { ElwoodSessionStatus } from "../../src/core/types.ts";

afterEach(() => vi.useRealTimers());

function harness() {
  vi.useFakeTimers();
  let status: ElwoodSessionStatus = "running";
  let handler: ((event: { readonly status: ElwoodSessionStatus }) => void) | undefined;
  const send = vi.fn(() => Promise.resolve());
  const interrupt = () =>
    sessionInterrupt(
      {
        on: (_event, next) => {
          handler = next;
          return () => {
            handler = undefined;
          };
        },
      },
      () => status,
      () => true,
      send,
      1_000,
      250,
    );
  const setStatus = (next: ElwoodSessionStatus, emit = true) => {
    status = next;
    if (emit) handler?.({ status });
  };
  return { send, interrupt, setStatus };
}

test("C-API-38 a swallowed first Escape is retried once after 250 ms", async () => {
  const h = harness();
  const result = h.interrupt();
  await vi.advanceTimersByTimeAsync(249);
  expect(h.send).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.send).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(500);
  expect(h.send).toHaveBeenCalledTimes(2);
  h.setStatus("ready");
  await result;
  expect(vi.getTimerCount()).toBe(0);
});

test.each([
  "ready",
  "blocked",
  "stopped",
] as const)("C-API-38 changing to %s before the retry prevents another Escape", async (status) => {
  const h = harness();
  const result = h.interrupt();
  const settled = result.catch(() => {});
  await vi.advanceTimersByTimeAsync(100);
  h.setStatus(status);
  await vi.advanceTimersByTimeAsync(250);
  expect(h.send).toHaveBeenCalledTimes(1);
  if (status === "blocked") h.setStatus("ready");
  await settled;
});

test("C-API-38 the retry checks current status even without an emitted edge", async () => {
  const h = harness();
  const result = h.interrupt();
  await vi.advanceTimersByTimeAsync(100);
  h.setStatus("ready", false);
  await vi.advanceTimersByTimeAsync(250);
  expect(h.send).toHaveBeenCalledTimes(1);
  h.setStatus("ready");
  await result;
});

test("C-API-38 a pending first Escape cannot overlap a retry or schedule one after ready", async () => {
  const h = harness();
  let finish!: () => void;
  h.send.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const result = h.interrupt();
  await vi.advanceTimersByTimeAsync(500);
  expect(h.send).toHaveBeenCalledTimes(1);
  h.setStatus("ready");
  await result;
  finish();
  await vi.advanceTimersByTimeAsync(500);
  expect(h.send).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

test("C-API-38 a failed retry rejects and cancels its deadline", async () => {
  const h = harness();
  h.send.mockResolvedValueOnce().mockRejectedValueOnce(new Error("retry failed"));
  const result = h.interrupt();
  const assertion = expect(result).rejects.toThrow("retry failed");
  await vi.advanceTimersByTimeAsync(250);
  await assertion;
  expect(vi.getTimerCount()).toBe(0);
});

test("C-API-38 leaving running while the first write is pending permanently cancels retry", async () => {
  const h = harness();
  let finish!: () => void;
  h.send.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const result = h.interrupt();
  h.setStatus("blocked");
  h.setStatus("running");
  finish();
  await vi.advanceTimersByTimeAsync(500);
  expect(h.send).toHaveBeenCalledTimes(1);
  h.setStatus("ready");
  await result;
});
