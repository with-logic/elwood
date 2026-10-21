/** Physical answer ownership, validation and native acknowledgement (C-QUESTION-02). */
import { afterEach, describe, expect, test } from "vitest";
import type { QuestionAdapter, QuestionIo } from "../../../src/core/questions/adapter.ts";
import { QuestionTransaction } from "../../../src/core/questions/transaction.ts";
import { PickerInputOwnership } from "../../../src/runtime/session/picker-input.ts";
import { createHeadlessTerminal } from "../../../src/terminal/headless.ts";
import { definitions, registry } from "./helpers.ts";

const terminals: ReturnType<typeof createHeadlessTerminal>[] = [];
afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose();
});
function setup(answer: (io: QuestionIo) => Promise<void>) {
  const writes: string[] = [];
  const terminal = createHeadlessTerminal({ cols: 140, rows: 45 }, (input) =>
    writes.push(String(input)),
  );
  terminals.push(terminal);
  const input = new PickerInputOwnership(terminal);
  const closing = new AbortController();
  const requests = registry();
  const request = requests.publish("native", "blocking", [definitions[0]!]);
  const answers = [
    { questionId: request.questions[0]!.id, optionIds: [request.questions[0]!.options[0]!.id] },
  ];
  const adapter: QuestionAdapter = {
    observe: () => {},
    render: () => {},
    blocksInput: () => true,
    answer: (_request, _answers, io) => answer(io),
  };
  const transaction = new QuestionTransaction(
    requests,
    input.automated,
    () => input.signal(),
    closing.signal,
  );
  return { writes, terminal, input, closing, requests, request, answers, adapter, transaction };
}
describe("C-QUESTION-02 answer lane", () => {
  test("writes without ordinary queue ownership and waits for native acceptance", async () => {
    const h = setup(async (io) => {
      await io.write("\r", (frame) => frame.text.includes("question"));
    });
    await h.terminal.writeOutput("question");
    const pending = h.transaction.run(h.adapter, h.request.id, h.answers, { timeoutMs: 500 });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(h.transaction.busy()).toBe(true);
    expect(h.writes).toEqual(["\r"]);
    const other = h.requests.publish("other", "queued", [definitions[0]!]);
    h.requests.close(other.id, "unavailable");
    h.requests.close(h.request.id, "answered");
    await pending;
    expect(h.transaction.busy()).toBe(false);
  });
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
  test("foreign frames and write failures preserve native pending request", async () => {
    const h = setup((io) => io.write("\r", () => false));
    await h.terminal.writeOutput("foreign dialog");
    await expect(h.transaction.run(h.adapter, h.request.id, h.answers)).rejects.toMatchObject({
      code: "question_answer_failed",
    });
    expect(h.requests.get(h.request.id)).toBe(h.request);
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
  test("only later completed renders satisfy a post-write wait", async () => {
    const h = setup(async (io) => {
      await io.write("x", () => true);
      await io.wait((frame) => frame.text.includes("accepted"));
    });
    await h.terminal.writeOutput("question");
    const pending = h.transaction.run(h.adapter, h.request.id, h.answers, { timeoutMs: 500 });
    await new Promise((resolve) => setTimeout(resolve, 25));
    await h.terminal.writeOutput(" accepted");
    await new Promise((resolve) => setTimeout(resolve, 25));
    h.requests.close(h.request.id, "answered");
    await pending;
    expect(h.writes).toEqual(["x"]);
  });
});
