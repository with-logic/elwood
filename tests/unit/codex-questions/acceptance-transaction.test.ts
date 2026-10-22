/** Unconfirmed native answers retain identity through the real transaction (PRD §4). */
import { expect, test } from "vitest";
import { queuedKey } from "../../../src/codex/questions/records.ts";
import { QuestionTransaction } from "../../../src/core/questions/transaction.ts";
import { createHeadlessTerminal } from "../../../src/terminal/headless.ts";
import { reply } from "./acceptance-helpers.ts";
import { harness } from "./adapter-helpers.ts";
import { captured, frame } from "./helpers.ts";

test("cancellation retires the old API ID; late acknowledgement releases it and a new identity can answer", async () => {
  const h = harness();
  const oldCallId = "old";
  const nextCallId = "next";
  const caller = new AbortController();
  const closing = new AbortController();
  const writes: string[] = [];
  const terminal = createHeadlessTerminal({ cols: 140, rows: 60 }, (input) => {
    writes.push(String(input));
    if (writes.length === 1) caller.abort();
    else h.adapter.observe(reply(queuedKey(nextCallId, 0), "Amber"));
  });
  const transaction = new QuestionTransaction(
    h.registry,
    terminal,
    () => new AbortController().signal,
    closing.signal,
  );
  const native = (callId: string) => ({
    payload: {
      type: "AgentMessage",
      id: callId,
      delivery: "async",
      questions: [{ title: "ELWOOD_ASYNC_COLOR: Which color?", options: ["Amber", "Blue"] }],
    },
  });
  const first = frame(captured("async-editor-first.txt").text.replace(/^ {2}1 of 2\n/m, ""));
  try {
    h.observe(native(oldCallId));
    h.adapter.render(first);
    const oldRequest = h.registry.list()[0];
    if (!oldRequest) throw new Error("Old native call did not publish an Elwood request");
    expect(h.registry.keyFor(oldRequest.id)).toBe(queuedKey(oldCallId, 0));
    const oldQuestion = oldRequest.questions[0];
    if (!oldQuestion) throw new Error("Old Elwood request has no question");
    const oldOption = oldQuestion.options[0];
    if (!oldOption) throw new Error("Old Elwood question has no option");
    const answers = [{ questionId: oldQuestion.id, optionIds: [oldOption.id] }];
    const cursorRow = first.lines.findLastIndex((line) => line.trim().length > 0) + 1;
    await terminal.writeOutput(`${first.text.replaceAll("\n", "\r\n")}\x1b[${cursorRow + 1};1H`);
    await expect(
      transaction.run(h.adapter, oldRequest.id, answers, {
        signal: caller.signal,
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ code: "question_answer_failed" });
    expect(writes).toEqual(["\r"]);
    expect(h.registry.list()).toEqual([]);
    expect(h.registry.hasPending()).toBe(true);
    await expect(transaction.run(h.adapter, oldRequest.id, answers)).rejects.toMatchObject({
      code: "question_not_found",
    });
    expect(writes).toEqual(["\r"]);
    h.adapter.observe(reply(queuedKey(oldCallId, 0), "late different manual value"));
    expect(h.registry.hasPending()).toBe(false);
    expect(
      h.events.filter((event) => event.phase === "closed" && event.request.id === oldRequest.id),
    ).toEqual([expect.objectContaining({ phase: "closed", reason: "unavailable" })]);
    const composer = frame("› Ask Codex to do anything\n\n  GPT-6-Luna low");
    h.adapter.render({ ...composer, cursorX: 2, cursorY: 0, cursorRow: 0, cursorVisible: true });
    expect(h.adapter.blocksInput()).toBe(false);
    h.observe(native(nextCallId));
    h.adapter.render(first);
    const nextRequest = h.registry.list()[0];
    if (!nextRequest) throw new Error("Next native call did not publish an Elwood request");
    expect(h.registry.keyFor(nextRequest.id)).toBe(queuedKey(nextCallId, 0));
    expect(nextRequest.id).not.toBe(oldRequest.id);
    const nextQuestion = nextRequest.questions[0];
    if (!nextQuestion) throw new Error("Next Elwood request has no question");
    const nextOption = nextQuestion.options[0];
    if (!nextOption) throw new Error("Next Elwood question has no option");
    await transaction.run(
      h.adapter,
      nextRequest.id,
      [{ questionId: nextQuestion.id, optionIds: [nextOption.id] }],
      { timeoutMs: 1000 },
    );
    expect(h.events.at(-1)).toMatchObject({
      phase: "closed",
      reason: "answered",
      request: nextRequest,
    });
    expect(writes).toEqual(["\r", "\r"]);
  } finally {
    closing.abort();
    h.registry.shutdown();
    terminal.dispose();
  }
});
