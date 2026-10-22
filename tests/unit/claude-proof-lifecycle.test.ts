/** Offline cancellation, close retry and diagnostic cleanup contracts (PRD §12). */
import { expect, test, vi } from "vitest";
import { claudeProofLifecycle } from "../e2e/questions/claude-lifecycle.ts";

test("cancellation during setup prevents lazy start but still disposes", async () => {
  const abort = new AbortController();
  const lifecycle = claudeProofLifecycle(abort.signal);
  abort.abort(new Error("synthetic setup cancellation"));
  const start = vi.fn(async () => undefined);
  await expect(lifecycle.start({ start, close: async () => undefined })).rejects.toBe(
    abort.signal.reason,
  );
  expect(start).not.toHaveBeenCalled();
  const dispose = vi.fn();
  await lifecycle.finish([dispose], true, vi.fn());
  expect(dispose).toHaveBeenCalledOnce();
});

test("cancellation joins in-flight lazy start and never returns a turn-ready session", async () => {
  const abort = new AbortController();
  const lifecycle = claudeProofLifecycle(abort.signal);
  const started = Promise.withResolvers<void>();
  const close = vi.fn(async () => {
    await started.promise;
  });
  const pending = lifecycle.start({ start: () => started.promise, close });
  const reason = new Error("synthetic startup cancellation");
  const rejected = expect(pending).rejects.toBe(reason);
  abort.abort(reason);
  expect(close).toHaveBeenCalledOnce();
  const dispose = vi.fn();
  const finish = lifecycle.finish([dispose], true, vi.fn());
  await Promise.resolve();
  expect(dispose).not.toHaveBeenCalled();
  started.resolve();
  await rejected;
  await finish;
  expect(close).toHaveBeenCalledOnce();
  expect(dispose).toHaveBeenCalledOnce();
});

test.each([
  { failed: false, diagnosticThrows: false },
  { failed: true, diagnosticThrows: false },
  { failed: true, diagnosticThrows: true },
])("cleanup attempts every action, primary=$failed throwing diagnostic=$diagnosticThrows", async ({
  failed,
  diagnosticThrows,
}) => {
  const lifecycle = claudeProofLifecycle(new AbortController().signal);
  const failure = new Error("close");
  await lifecycle.start({
    start: async () => undefined,
    close: () => Promise.reject(failure),
  });
  const dispose = vi.fn();
  const diagnostic = vi.fn(() => {
    if (diagnosticThrows) throw new Error("synthetic diagnostic failure");
  });
  const finish = lifecycle.finish(
    [
      () => {
        throw new Error("privacy");
      },
      dispose,
    ],
    failed,
    diagnostic,
  );
  if (failed) await expect(finish).resolves.toBeUndefined();
  else await expect(finish).rejects.toMatchObject({ errors: [failure, new Error("privacy")] });
  expect(dispose).toHaveBeenCalledOnce();
  expect(diagnostic).toHaveBeenCalledTimes(failed ? 1 : 0);
  if (failed) expect(diagnostic).toHaveBeenCalledWith("Claude question proof cleanup also failed");
});

test.each([
  false,
  true,
])("finalization retries failed cancellation close, settled=%s", async (settled) => {
  const abort = new AbortController();
  const lifecycle = claudeProofLifecycle(abort.signal);
  const first = Promise.withResolvers<void>();
  const close = vi
    .fn<() => Promise<void>>()
    .mockImplementationOnce(() => first.promise)
    .mockResolvedValue(undefined);
  await lifecycle.start({ start: async () => undefined, close });
  abort.abort();
  if (settled) {
    first.reject(new Error("first close failed"));
    await Promise.resolve();
  }
  const dispose = vi.fn();
  const finish = lifecycle.finish([dispose], true, vi.fn());
  if (!settled) {
    await Promise.resolve();
    expect(dispose).not.toHaveBeenCalled();
    first.reject(new Error("first close failed"));
  }
  await finish;
  expect(close).toHaveBeenCalledTimes(2);
  expect(dispose).toHaveBeenCalledOnce();
});
