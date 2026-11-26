/** Real Codex queued and modal questions answered in a narrow pane (PRD §5.10, C-QUESTION-04). */
import assert from "node:assert/strict";
import test from "node:test";
import type { ElwoodQuestionEvent, ElwoodQuestionRequest } from "../../src/index.ts";
import { asyncPrompt, modalPrompt } from "./questions/codex-prompts.ts";
import {
  publicCodexOptionAnswer,
  publicCodexQuestionSandbox,
  publicCodexQuestionSession,
  waitForPublicCodexQuestion,
  waitForPublicCodexQuestionBefore,
} from "./questions/codex-public-sandbox.ts";
import { codexQuestionProofSkip } from "./questions/codex-sandbox.ts";

const textAnswer = (request: ElwoodQuestionRequest, text: string) => {
  const [question] = request.questions;
  assert.ok(question, "Native question request contains no questions");
  return [{ questionId: question.id, text }];
};

test("C-QUESTION-04 queued and modal Codex questions are answered in a 50-column pane", {
  skip: codexQuestionProofSkip("two valid-model turns in one session"),
  timeout: 240_000,
}, async () => {
  const sandbox = await publicCodexQuestionSandbox();
  // At 50 columns Codex 0.172 wraps the footer of a queued panel that has a next question,
  // and splits a modal question's footer after its second hint.
  const session = publicCodexQuestionSession(sandbox, { cols: 50, rows: 45 });
  const events: ElwoodQuestionEvent[] = [];
  const statuses: string[] = [];
  session.on("question", (event) => events.push(event));
  session.on("status", (event) => statuses.push(event.status));
  const raised = (count: number) => () =>
    events.filter((event) => event.phase === "raised").length === count;
  try {
    const live = await session.start();
    await live.waitForStatus((status) => status === "ready", 45_000);
    const queued = session.send(asyncPrompt, { timeoutMs: 90_000 });
    // If a step below fails, cleanup's close() rejects this send; handle that rejection here so
    // the runner reports the failed step.
    queued.catch(() => undefined);
    await waitForPublicCodexQuestionBefore(raised(3), queued);
    const [color, note, literal] = await session.listQuestions();
    assert.ok(color && note && literal);
    // The note is question 2 of 3 and the color then 1 of 2: both footers wrap.
    await session.answerQuestions(note.id, textAnswer(note, "narrow note"), { timeoutMs: 30_000 });
    await session.answerQuestions(color.id, [publicCodexOptionAnswer(color, "Blue")], {
      timeoutMs: 30_000,
    });
    await session.answerQuestions(literal.id, textAnswer(literal, "narrow literal"), {
      timeoutMs: 30_000,
    });
    assert.equal((await queued).trim(), "ELWOOD_ASYNC_DONE");
    assert.ok(statuses.includes("blocked"), `the queued panel never blocked: ${statuses}`);

    await live.sendKeys("/plan");
    await waitForPublicCodexQuestion(() => /^›\s*\/plan\s*$/m.test(live.terminal.snapshot().text));
    await live.sendKeys("\r");
    await waitForPublicCodexQuestion(() => live.terminal.snapshot().text.includes("Plan mode"));
    const blockedBefore = statuses.length;
    const modal = session.send(modalPrompt, { timeoutMs: 90_000 });
    modal.catch(() => undefined);
    await waitForPublicCodexQuestionBefore(raised(4), modal);
    const [grouped] = await session.listQuestions();
    assert.ok(grouped);
    assert.equal(grouped.delivery, "blocking");
    const answers = grouped.questions.map((question) => {
      const [first] = question.options;
      assert.ok(first, `${question.prompt} offered no options`);
      return { questionId: question.id, optionIds: [first.id] };
    });
    await session.answerQuestions(grouped.id, answers, { timeoutMs: 30_000 });
    assert.equal((await modal).trim(), "ELWOOD_MODAL_DONE");
    assert.ok(
      statuses.slice(blockedBefore).includes("blocked"),
      "the modal question never blocked",
    );
    assert.deepEqual(
      events.filter((event) => event.phase === "closed").map((event) => event.reason),
      ["answered", "answered", "answered", "answered"],
    );
  } finally {
    try {
      await session.close();
    } finally {
      sandbox.dispose();
    }
  }
});
