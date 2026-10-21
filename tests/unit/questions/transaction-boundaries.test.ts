/** Native acceptance, cancellation and retry preserve one answer lane (PRD §4). */
import { afterEach, expect, test, vi } from "vitest";
import { questionDeadline } from "../../../src/core/questions/deadline.ts";
import { MAX_TIMER_DELAY_MS } from "../../../src/core/timers.ts";
import { definitions } from "./helpers.ts";
import { disposeTransactionHarnesses, transactionHarness as setup } from "./transaction-helpers.ts";

afterEach(async () => {
  vi.useRealTimers();
  await disposeTransactionHarnesses();
});
test("long finite timeouts use bounded timer chunks instead of Node's 1 ms overflow", async () => {
  const h = setup(async () => {});
  await h.terminal.writeOutput("question");
  vi.useFakeTimers();
  const pending = h.transaction.run(h.adapter, h.request.id, h.answers, {
    timeoutMs: MAX_TIMER_DELAY_MS + 1,
  });
  const result = pending.then(
    () => "accepted",
    () => "failed",
  );
  await vi.advanceTimersByTimeAsync(MAX_TIMER_DELAY_MS);
  expect(h.transaction.busy()).toBe(true);
  expect(h.requests.get(h.request.id)).toBe(h.request);
  h.requests.close(h.request.id, "answered");
  expect(await result).toBe("accepted");
});
test("a deadline expires after its last bounded chunk and cancellation clears it", async () => {
  vi.useFakeTimers();
  const expire = vi.fn();
  const cancel = questionDeadline(MAX_TIMER_DELAY_MS + 3, expire);
  await vi.advanceTimersByTimeAsync(MAX_TIMER_DELAY_MS + 2);
  expect(expire).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(expire).toHaveBeenCalledOnce();
  cancel();
  const cancelPending = questionDeadline(100, expire);
  cancelPending();
  await vi.advanceTimersByTimeAsync(100);
  expect(expire).toHaveBeenCalledOnce();
});
test.each([
  "revoke",
  "timeout",
  "signal",
  "caller",
] as const)("%s after the first write retires the request and reserves its native key until closure", async (reason) => {
  const host = new AbortController();
  let firstWrite = false;
  const h = setup(async (io) => {
    await io.write("first", () => true);
    firstWrite = true;
    await io.wait(() => false);
    await io.write("forbidden", () => true);
  });
  await h.terminal.writeOutput("question");
  vi.useFakeTimers();
  const pending = h.transaction.run(h.adapter, h.request.id, h.answers, {
    timeoutMs: 1000,
    signal: host.signal,
  });
  const failed = expect(pending).rejects.toMatchObject({ code: "question_answer_failed" });
  await vi.advanceTimersByTimeAsync(0);
  expect(firstWrite).toBe(true);
  if (reason === "revoke") h.transaction.revoke();
  if (reason === "signal") host.abort();
  if (reason === "caller") await h.input.caller.sendInput("human");
  await vi.advanceTimersByTimeAsync(reason === "timeout" ? 1000 : 20);
  await failed;
  expect(h.transaction.busy()).toBe(true);
  expect(h.writes).toEqual(reason === "caller" ? ["first", "human"] : ["first"]);
  const retry = {
    ...h.adapter,
    answer: () => {
      h.requests.close(h.request.id, "answered");
      return Promise.resolve();
    },
  };
  await expect(h.transaction.run(retry, h.request.id, h.answers)).rejects.toMatchObject({
    code: "question_not_found",
  });
  expect(h.requests.get(h.request.id)).toBeUndefined();
  expect(h.requests.list()).toEqual([]);
  expect(h.requests.find("native")).toBe(h.request);
  expect(h.requests.hasPending()).toBe(true);
  h.requests.close(h.request.id, "unavailable");
  expect(h.requests.hasPending()).toBe(false);
  expect(h.transaction.busy()).toBe(false);
});

test("an adapter-side shutdown cannot leave the native acceptance wait pending", async () => {
  const h = setup((io) => {
    expect(io.frame()?.text).toContain("question");
    h.closing.abort();
    return Promise.resolve();
  });
  await h.terminal.writeOutput("question");
  await expect(h.transaction.run(h.adapter, h.request.id, h.answers)).rejects.toMatchObject({
    code: "question_answer_failed",
  });
  expect(h.transaction.busy()).toBe(false);
});

test("writes without ordinary queue ownership and waits for native acceptance", async () => {
  const sent = Promise.withResolvers<void>();
  const h = setup(async (io) => {
    await io.write("\r", (frame) => frame.text.includes("question"));
    sent.resolve();
  });
  await h.terminal.writeOutput("question");
  const pending = h.transaction.run(h.adapter, h.request.id, h.answers, { timeoutMs: 500 });
  await Promise.race([sent.promise, pending]);
  expect(h.transaction.busy()).toBe(true);
  expect(h.writes).toEqual(["\r"]);
  const other = h.requests.publish("other", "queued", [definitions[0]!])!;
  h.requests.close(other.id, "unavailable");
  h.requests.close(h.request.id, "answered");
  await pending;
  expect(h.transaction.busy()).toBe(false);
});

test("a closure acknowledgement ends write authority even while its old frame remains", async () => {
  const h = setup(async (io) => {
    h.requests.close(h.request.id, "answered");
    await io.write("\r", () => true);
  });
  await h.terminal.writeOutput("question");
  await expect(h.transaction.run(h.adapter, h.request.id, h.answers)).rejects.toMatchObject({
    code: "question_answer_failed",
  });
  expect(h.writes).toEqual([]);
});
