/** Transaction harness shutdown settles even an uncooperative adapter (PRD §4). */
import { afterEach, expect, test, vi } from "vitest";
import { disposeTransactionHarnesses, transactionHarness as setup } from "./transaction-helpers.ts";

afterEach(async () => {
  await disposeTransactionHarnesses();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
test("harness disposal cancels and settles even an adapter that ignores its signal", async () => {
  const entered = Promise.withResolvers<void>();
  const h = setup(() => {
    entered.resolve();
    return new Promise<void>(() => {});
  });
  await h.terminal.writeOutput("question");
  vi.useFakeTimers();
  const result = h.transaction.run(h.adapter, h.request.id, h.answers).catch(() => "failed");
  await entered.promise;
  await disposeTransactionHarnesses();
  expect(h.transaction.busy()).toBe(false);
  expect(await result).toBe("failed");
  expect(vi.getTimerCount()).toBe(0);
});
