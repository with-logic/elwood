/** Physical answer ownership, validation and native acknowledgement (PRD §4). */
import { afterEach, describe, expect, test, vi } from "vitest";
import { disposeTransactionHarnesses, transactionHarness as setup } from "./transaction-helpers.ts";

afterEach(async () => {
  await disposeTransactionHarnesses();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe("answer lane", () => {
  test("invalid or stale batches make zero writes, including unavailable adapter", async () => {
    const h = setup((io) => io.write("\r", () => true));
    await h.terminal.writeOutput("question");
    await expect(h.transaction.run(h.adapter, "foreign", h.answers)).rejects.toMatchObject({
      code: "question_not_found",
    });
    await expect(h.transaction.run(h.adapter, h.request.id, [])).rejects.toMatchObject({
      code: "invalid_question_answer",
    });
    await expect(h.transaction.run(undefined, h.request.id, h.answers)).rejects.toMatchObject({
      code: "question_answer_failed",
    });
    expect(h.writes).toEqual([]);
  });
  test("caller takeover, explicit revoke, shutdown and timeout stop writes", async () => {
    for (const reason of ["caller", "revoke", "closing", "timeout", "cancelled"] as const) {
      const h = setup(async (io) => {
        await io.wait(() => false);
        await io.write("\r", () => true);
      });
      await h.terminal.writeOutput("question");
      const pending = h.transaction.run(h.adapter, h.request.id, h.answers, { timeoutMs: 40 });
      const rejected = expect(pending).rejects.toMatchObject({ code: "question_answer_failed" });
      if (reason === "caller") await h.input.caller.sendInput("x");
      if (reason === "revoke") h.transaction.revoke();
      if (reason === "closing") h.closing.abort();
      if (reason === "cancelled") h.requests.close(h.request.id, "cancelled");
      await rejected;
      expect(h.writes).toEqual(reason === "caller" ? ["x"] : []);
    }
  });
  test("rejects overlapping answers and a pre-aborted host signal", async () => {
    const h = setup(async (io) => {
      await io.wait(() => false);
    });
    const pending = h.transaction.run(h.adapter, h.request.id, h.answers, { timeoutMs: 50 });
    const failure = expect(pending).rejects.toMatchObject({ code: "question_answer_failed" });
    await expect(h.transaction.run(h.adapter, h.request.id, h.answers)).rejects.toMatchObject({
      code: "question_answer_failed",
    });
    h.transaction.revoke();
    await failure;
    const signal = AbortSignal.abort();
    await expect(
      h.transaction.run(h.adapter, h.request.id, h.answers, { signal }),
    ).rejects.toMatchObject({ code: "question_answer_failed" });
    expect(h.writes).toEqual([]);
  });
});
