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
  const caller = new AbortController();
  const closing = new AbortController();
  const writes: string[] = [];
  const terminal = createHeadlessTerminal({ cols: 140, rows: 60 }, (input) => {
    writes.push(String(input));
    if (writes.length === 1) caller.abort();
    else h.adapter.observe(reply(queuedKey("next", 0), "Amber"));
  });
  const transaction = new QuestionTransaction(
    h.registry,
    terminal,
    () => new AbortController().signal,
    closing.signal,
  );
  const native = (id: string) => ({
    payload: {
      type: "AgentMessage",
      id,
      delivery: "async",
      questions: [{ title: "ELWOOD_ASYNC_COLOR: Which color?", options: ["Amber", "Blue"] }],
    },
  });
  const first = frame(captured("async-editor-first.txt").text.replace(/^ {2}1 of 2\n/m, ""));
  try {
    h.observe(native("old"));
    h.adapter.render(first);
    const request = h.registry.list()[0]!;
    const answers = [
      { questionId: request.questions[0]!.id, optionIds: [request.questions[0]!.options[0]!.id] },
    ];
    const cursorRow = first.lines.findLastIndex((line) => line.trim().length > 0) + 1;
    await terminal.writeOutput(`${first.text.replaceAll("\n", "\r\n")}\x1b[${cursorRow + 1};1H`);
    await expect(
      transaction.run(h.adapter, request.id, answers, { signal: caller.signal, timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: "question_answer_failed" });
    expect(writes).toEqual(["\r"]);
    expect(h.registry.list()).toEqual([]);
    expect(h.registry.hasPending()).toBe(true);
    await expect(transaction.run(h.adapter, request.id, answers)).rejects.toMatchObject({
      code: "question_not_found",
    });
    expect(writes).toEqual(["\r"]);
    h.adapter.observe(reply(queuedKey("old", 0), "late different manual value"));
    expect(h.registry.hasPending()).toBe(false);
    expect(
      h.events.filter((event) => event.phase === "closed" && event.request.id === request.id),
    ).toEqual([expect.objectContaining({ phase: "closed", reason: "unavailable" })]);
    const composer = frame("› Ask Codex to do anything\n\n  GPT-6-Luna low");
    h.adapter.render({ ...composer, cursorX: 2, cursorY: 0, cursorRow: 0, cursorVisible: true });
    expect(h.adapter.blocksInput()).toBe(false);
    h.observe(native("next"));
    h.adapter.render(first);
    const current = h.registry.list()[0]!;
    expect(current.id).not.toBe(request.id);
    await transaction.run(
      h.adapter,
      current.id,
      [{ questionId: current.questions[0]!.id, optionIds: [current.questions[0]!.options[0]!.id] }],
      { timeoutMs: 1000 },
    );
    expect(h.events.at(-1)).toMatchObject({
      phase: "closed",
      reason: "answered",
      request: current,
    });
    expect(writes).toEqual(["\r", "\r"]);
  } finally {
    closing.abort();
    h.registry.shutdown();
    terminal.dispose();
  }
});
