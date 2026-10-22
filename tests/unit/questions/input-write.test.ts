/** Terminal failures and late transport completion remain observed and content-free (PRD §4). */
import { afterEach, expect, test, vi } from "vitest";
import { disposeInputHarnesses, inputHarness as setup } from "./input-helpers.ts";

afterEach(async () => {
  await disposeInputHarnesses();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("assertLive rejection prevents real terminal dispatch without signal abortion", async () => {
  const failure = new Error("Session is no longer live.");
  const h = setup(() => {
    throw failure;
  });
  await h.terminal.writeOutput("question");
  const send = vi.spyOn(h.input.automated, "sendInput");
  const onDispatch = vi.fn();
  expect(h.io.signal.aborted).toBe(false);
  await expect(h.track(h.io.write("forbidden", () => true, onDispatch))).rejects.toBe(failure);
  expect(h.io.signal.aborted).toBe(false);
  expect(onDispatch).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  expect(h.writes).toEqual([]);
  expect(h.started).not.toHaveBeenCalled();
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
  const onDispatch = vi.fn();
  if (when === "before write") h.operation.abort();
  await expect(
    h.track(
      h.io.write(
        "forbidden",
        () => {
          if (when === "inside predicate") h.operation.abort();
          return true;
        },
        onDispatch,
      ),
    ),
  ).rejects.toMatchObject({ code: "question_answer_failed" });
  expect(onDispatch).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  expect(h.writes).toEqual([]);
  expect(h.started).not.toHaveBeenCalled();
});

test.each([
  "nonmatching frame",
  "closed request",
  "request closed by predicate",
] as const)("%s rejects before the real input dispatch callback", async (reason) => {
  const h = setup();
  await h.terminal.writeOutput("foreign frame");
  const send = vi.spyOn(h.input.automated, "sendInput");
  const onDispatch = vi.fn();
  if (reason === "closed request") h.requests.close(h.request.id, "answered");
  await expect(
    h.track(
      h.io.write(
        "forbidden",
        (frame) => {
          if (reason === "request closed by predicate") h.requests.close(h.request.id, "answered");
          return reason !== "nonmatching frame" || frame.text.includes("native questionnaire");
        },
        onDispatch,
      ),
    ),
  ).rejects.toMatchObject({ code: "question_answer_failed" });
  expect(onDispatch).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  expect(h.writes).toEqual([]);
  expect(h.started).not.toHaveBeenCalled();
});
