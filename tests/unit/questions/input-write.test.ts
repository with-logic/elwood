/** Terminal failures and late transport completion remain observed and content-free (PRD §4). */
import { afterEach, expect, test, vi } from "vitest";
import { disposeInputHarnesses, inputHarness as setup } from "./input-helpers.ts";

afterEach(async () => {
  await disposeInputHarnesses();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("raw terminal errors never retain answer-bearing causes", async () => {
  const h = setup();
  await h.terminal.writeOutput("question");
  const secret = "PRIVATE_NATIVE_ANSWER";
  vi.spyOn(h.input.automated, "sendInput").mockRejectedValueOnce(new Error(secret));
  const failure: unknown = await h
    .track(h.io.write("answer", () => true))
    .catch((error: unknown) => error);
  expect(failure).toMatchObject({ code: "question_answer_failed" });
  expect(h.started).toHaveBeenCalledOnce();
  expect(h.failed).toHaveBeenCalledOnce();
  expect(String(failure)).not.toContain(secret);
  expect(JSON.stringify(failure)).not.toContain(secret);
  expect(failure).toBeInstanceOf(Error);
  if (failure instanceof Error) {
    expect(failure.stack).not.toContain(secret);
    expect(failure.cause).toBeUndefined();
  }
});

test("revocation releases a held write while observing its real late delivery", async () => {
  const h = setup();
  await h.terminal.writeOutput("question");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  const send = h.input.automated.sendInput.bind(h.input.automated);
  vi.spyOn(h.input.automated, "sendInput").mockImplementationOnce(async (input) => {
    entered.resolve();
    await release.promise;
    await send(input);
    completed.resolve();
  });
  vi.useFakeTimers();
  let outcome = "pending";
  try {
    const pending = h.track(h.io.write("answer", () => true));
    const rejected = pending.catch((error: unknown) => {
      outcome = "failed";
      return error;
    });
    await entered.promise;
    h.operation.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toBe("failed");
    expect(await rejected).toMatchObject({ code: "question_answer_failed" });
    expect(h.writes).toEqual([]);
    expect(h.failed).toHaveBeenCalledOnce();
    release.resolve();
    await completed.promise;
    expect(h.writes).toEqual(["answer"]);
  } finally {
    release.resolve();
  }
});

test("a write that synchronously revokes authority cannot miss its pre-aborted signal", async () => {
  const h = setup();
  await h.terminal.writeOutput("question");
  vi.spyOn(h.input.automated, "sendInput").mockImplementationOnce(() => {
    h.operation.abort();
    return Promise.resolve();
  });
  await expect(h.track(h.io.write("answer", () => true))).rejects.toMatchObject({
    code: "question_answer_failed",
  });
  expect(h.failed).toHaveBeenCalledOnce();
  expect(h.writes).toEqual([]);
});

test.each([
  "before write",
  "inside predicate",
])("cancellation %s prevents real terminal dispatch independently of assertLive", async (when) => {
  const h = setup();
  await h.terminal.writeOutput("question");
  const send = vi.spyOn(h.input.automated, "sendInput");
  if (when === "before write") h.operation.abort();
  await expect(
    h.track(
      h.io.write("forbidden", () => {
        if (when === "inside predicate") h.operation.abort();
        return true;
      }),
    ),
  ).rejects.toMatchObject({ code: "question_answer_failed" });
  expect(send).not.toHaveBeenCalled();
  expect(h.writes).toEqual([]);
  expect(h.started).not.toHaveBeenCalled();
});
