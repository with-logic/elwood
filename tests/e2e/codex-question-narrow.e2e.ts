/** Real Codex queued questions answered in a narrow pane (PRD §5.10, C-QUESTION-04). */
import assert from "node:assert/strict";
import test from "node:test";
import type { ElwoodQuestionEvent } from "../../src/index.ts";
import { asyncPrompt } from "./questions/codex-prompts.ts";
import {
  publicCodexOptionAnswer,
  publicCodexQuestionSandbox,
  publicCodexQuestionSession,
  publicCodexTextAnswer,
  waitForPublicCodexQuestionBefore,
} from "./questions/codex-public-sandbox.ts";
import { codexQuestionProofSkip } from "./questions/codex-sandbox.ts";

test("C-QUESTION-04 queued Codex questions are answered in a 50-column pane", {
  skip: codexQuestionProofSkip("one valid-model turn"),
  timeout: 240_000,
}, async () => {
  const sandbox = await publicCodexQuestionSandbox();
  // At 50 columns Codex 0.172 wraps the footer of a queued panel that has a next question.
  const session = publicCodexQuestionSession(sandbox, { cols: 50, rows: 45 });
  const events: ElwoodQuestionEvent[] = [];
  const statuses: string[] = [];
  session.on("question", (event) => events.push(event));
  session.on("status", (event) => statuses.push(event.status));
  const raised = () => events.filter((event) => event.phase === "raised").length === 3;
  try {
    const live = await session.start();
    await live.waitForStatus((status) => status === "ready", 45_000);
    const queued = session.send(asyncPrompt, { timeoutMs: 90_000 });
    // If a step below fails, cleanup's close() rejects this send; handle that rejection here so
    // the runner reports the failed step.
    queued.catch(() => undefined);
    await waitForPublicCodexQuestionBefore(raised, queued);
    const [color, note, literal] = await session.listQuestions();
    assert.ok(color && note && literal);
    // The note is question 2 of 3 and the color then 1 of 2: both footers wrap.
    await session.answerQuestions(note.id, [publicCodexTextAnswer(note, "narrow note")], {
      timeoutMs: 30_000,
    });
    await session.answerQuestions(color.id, [publicCodexOptionAnswer(color, "Blue")], {
      timeoutMs: 30_000,
    });
    await session.answerQuestions(literal.id, [publicCodexTextAnswer(literal, "narrow literal")], {
      timeoutMs: 30_000,
    });
    assert.equal((await queued).trim(), "ELWOOD_ASYNC_DONE");
    assert.ok(statuses.includes("blocked"), `the queued panel never blocked: ${statuses}`);
    assert.deepEqual(
      events.filter((event) => event.phase === "closed").map((event) => event.reason),
      ["answered", "answered", "answered"],
    );
  } finally {
    try {
      await session.close();
    } finally {
      sandbox.dispose();
    }
  }
});
