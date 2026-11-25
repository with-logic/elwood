/** Verify guarded writes, bounded cancellation, and outcome categories (C-ATTN-07). */
import { afterEach, expect, test, vi } from "vitest";
import { WorkspaceTrustAnswers } from "../../src/core/dialogs/trust-answer/index.ts";
import type { AnswerFailureCategory } from "../../src/core/dialogs/trust-answer/io.ts";
import type { SelectableOption } from "../../src/core/terminal-options.ts";

afterEach(() => vi.useRealTimers());
function setup(confirm = true) {
  const row = { style: "numbered", number: "1", selected: true, label: "Trust" } as const;
  const frame = {};
  const currentRequest = vi.fn(() => ({
    gateIdentity: "folder",
    choices: [{ id: "choice", choiceIndex: 0, outcome: "affirmative" }] as const,
    request: { id: "request" },
  }));
  const readChoice = vi.fn<() => { frame: object; option: SelectableOption } | undefined>(() => ({
    frame,
    option: row,
  }));
  const write = vi.fn<(keys: string) => Promise<void>>().mockResolvedValue(undefined);
  const relinquish = vi.fn();
  const reconcile = vi.fn();
  const answers = new WorkspaceTrustAnswers({
    currentRequest,
    readChoice(_gate, _index, _requestId, _previousFrame, finish) {
      const choice = readChoice();
      finish(choice && { ...choice, claim: () => true });
    },
    step: () => ({ keys: "\r", confirm }),
    write,
    reconcileDialogEvidence: reconcile,
    relinquish,
  });
  return { answers, write, readChoice, relinquish, reconcile };
}
const answer = (answers: Pick<WorkspaceTrustAnswers, "answer">) =>
  answers.answer("request", "choice");
const failed = (category: AnswerFailureCategory) => ({
  code: "dialog_answer_failed",
  details: { category },
});
test("C-ATTN-07 validates options and choice before acquiring the writer", async () => {
  const { answers, write } = setup();
  for (const options of [
    42,
    null,
    [],
    { timeoutMs: 0 },
    { timeoutMs: Number.POSITIVE_INFINITY },
    { signal: {} },
  ]) {
    await expect(
      Reflect.apply(answers.answer, answers, ["request", "choice", options]),
    ).rejects.toMatchObject({ code: "invalid_dialog_answer" });
  }
  await expect(answers.answer("request", "other")).rejects.toMatchObject({
    code: "invalid_dialog_answer",
  });
  await expect(
    answers.answer("request", "choice", { signal: AbortSignal.abort() }),
  ).rejects.toMatchObject(failed("aborted"));
  expect(write).not.toHaveBeenCalled();
});
test("C-ATTN-07 a missing verified choice refuses the first key", async () => {
  const { answers, write, readChoice } = setup();
  readChoice.mockReturnValue(undefined);
  await expect(answer(answers)).rejects.toMatchObject(failed("frame"));
  expect(write).not.toHaveBeenCalled();
});

test("C-ATTN-07 a busy answer ignores unrelated outcomes and errors after confirmation", async () => {
  const { answers, write, reconcile } = setup();
  const outcomes: boolean[] = [];
  reconcile.mockImplementationOnce(() => {
    outcomes.push(answers.recordConfirmation("back"), answers.recordConfirmation("affirmative"));
    throw new Error("optional reconciliation failed after confirmation");
  });
  const operation = answer(answers);
  await expect(answer(answers)).rejects.toMatchObject(failed("busy"));
  await expect(operation).resolves.toBeUndefined();
  expect(outcomes).toEqual([false, true]);
  expect(write.mock.calls).toEqual([["\r"]]);
});

test("C-ATTN-07 withdrawal rejects an in-flight write and ignores late fulfillment", async () => {
  const { answers, write, readChoice, reconcile, relinquish } = setup();
  const writeResult = Promise.withResolvers<void>();
  write.mockReturnValue(writeResult.promise);
  const controller = new AbortController();
  const operation = answers.answer("request", "choice", { signal: controller.signal });
  answers.resumeNavigation();
  expect(readChoice).toHaveBeenCalledOnce();
  controller.abort();
  await expect(operation).rejects.toMatchObject(failed("aborted"));
  writeResult.resolve();
  await writeResult.promise;
  expect(relinquish).toHaveBeenCalledWith("folder");
  expect(reconcile).not.toHaveBeenCalled();
});

test("C-ATTN-07 a rejected native write does not report success", async () => {
  const { answers, write, relinquish } = setup();
  write.mockRejectedValue(new Error("terminal write failed"));
  await expect(answer(answers)).rejects.toMatchObject(failed("terminal_write"));
  expect(relinquish).toHaveBeenCalledWith("folder");
});

test("C-ATTN-07 the answer deadline includes an in-flight confirmation write", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const { answers, write, readChoice, reconcile } = setup();
  const writeResult = Promise.withResolvers<void>();
  write.mockReturnValue(writeResult.promise);
  const reject = vi.fn();
  const operation = answers.answer("request", "choice", { timeoutMs: 50 }).catch(reject);
  expect(write).toHaveBeenCalledExactlyOnceWith("\r");
  await vi.advanceTimersByTimeAsync(50);
  expect(reject.mock.lastCall?.[0]).toMatchObject(failed("native_acceptance"));
  writeResult.resolve();
  await operation;
  expect(reconcile).not.toHaveBeenCalled();
  expect(readChoice).toHaveBeenCalledOnce();
  expect(write).toHaveBeenCalledOnce();
});

test("C-ATTN-07 a workspace answer defaults to a 12-second confirmation deadline", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const { answers } = setup();
  const settled = vi.fn();
  const operation = answers.answer("request", "choice").catch((error: unknown) => {
    settled();
    return error;
  });
  await vi.advanceTimersByTimeAsync(11_999);
  expect(settled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(settled).toHaveBeenCalledOnce();
  expect(await operation).toMatchObject(failed("native_acceptance"));
});

test("C-ATTN-07 native exit cannot confirm an affirmative answer", async () => {
  const { answers, write, reconcile } = setup();
  const operation = answer(answers);
  expect(write).toHaveBeenCalledExactlyOnceWith("\r");
  await write.mock.results[0]!.value;
  expect(reconcile).toHaveBeenCalledOnce();
  answers.nativeExit(true);
  await expect(operation).rejects.toMatchObject(failed("terminal_exit"));
});

test("C-ATTN-07 final verification cannot authorize a key after the absolute deadline", async () => {
  const now = vi.spyOn(performance, "now").mockReturnValue(0);
  const { answers, readChoice, write } = setup();
  readChoice.mockImplementation(() => {
    now.mockReturnValue(50);
    return {
      frame: {},
      option: { style: "numbered", label: "Trust", selected: true, number: "1" },
    };
  });
  try {
    await expect(answers.answer("request", "choice", { timeoutMs: 50 })).rejects.toMatchObject(
      failed("frame"),
    );
    expect(write).not.toHaveBeenCalled();
  } finally {
    now.mockRestore();
  }
});

test("C-ATTN-07 a late rejected native write cannot own an already revoked answer", async () => {
  const { answers, write, relinquish } = setup();
  const pending = Promise.withResolvers<void>();
  write.mockReturnValue(pending.promise);
  const operation = answer(answers);
  answers.revoke();
  await expect(operation).rejects.toMatchObject(failed("aborted"));
  pending.reject(new Error("late PTY failure"));
  await expect(pending.promise).rejects.toThrow("late PTY failure");
  expect(relinquish).toHaveBeenCalledOnce();
});

test("C-ATTN-07 after navigating, a missing frame waits instead of sending another key", async () => {
  const { answers, write, readChoice } = setup(false);
  const operation = answer(answers);
  readChoice.mockReturnValue(undefined);
  await write.mock.results[0]?.value;
  expect(write.mock.calls).toEqual([["\r"]]);
  answers.revoke();
  await expect(operation).rejects.toMatchObject(failed("aborted"));
});

test("C-ATTN-07 an unchanged native frame cannot send another navigation key", async () => {
  const { answers, write } = setup(false);
  const operation = answer(answers);
  await write.mock.results[0]?.value;
  answers.resumeNavigation();
  expect(write.mock.calls).toEqual([["\r"]]);
  answers.revoke();
  await expect(operation).rejects.toMatchObject(failed("aborted"));
});
