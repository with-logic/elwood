/** Real Codex queued questions answered in a narrow pane (PRD §5.10, C-QUESTION-04). */
import assert from "node:assert/strict";
import test from "node:test";
import type { ElwoodQuestionEvent } from "../../src/index.ts";
import { narrowPrompt } from "./questions/codex-prompts.ts";
import {
  publicCodexOptionAnswer,
  publicCodexQuestionSandbox,
  publicCodexQuestionSession,
  waitForPublicCodexQuestion,
} from "./questions/codex-public-sandbox.ts";
import { codexQuestionProofSkip } from "./questions/codex-sandbox.ts";

test("C-QUESTION-04 queued Codex questions are answered in a 50-column pane", {
  skip: codexQuestionProofSkip("one valid-model turn"),
  timeout: 180_000,
}, async () => {
  const sandbox = await publicCodexQuestionSandbox();
  // At 50 columns Codex 0.172 wraps the queued panel's footer hints onto a second row.
  const session = publicCodexQuestionSession(sandbox, { cols: 50, rows: 45 });
  const events: ElwoodQuestionEvent[] = [];
  session.on("question", (event) => events.push(event));
  try {
    const live = await session.start();
    await live.waitForStatus((status) => status === "ready", 45_000);
    const reply = session.send(narrowPrompt, { timeoutMs: 90_000 });
    // If a step below fails, cleanup's close() rejects this send; handle that rejection here so
    // the runner reports the failed step.
    reply.catch(() => undefined);
    await waitForPublicCodexQuestion(() => events.filter((e) => e.phase === "raised").length === 2);
    const [color, note] = await session.listQuestions();
    assert.ok(color && note);
    await session.answerQuestions(color.id, [publicCodexOptionAnswer(color, "Blue")], {
      timeoutMs: 30_000,
    });
    await session.answerQuestions(
      note.id,
      [{ questionId: note.questions[0]!.id, text: "narrow note" }],
      { timeoutMs: 30_000 },
    );
    assert.equal((await reply).trim(), "ELWOOD_NARROW_DONE");
    assert.deepEqual(
      events.filter((event) => event.phase === "closed").map((event) => event.reason),
      ["answered", "answered"],
    );
  } finally {
    try {
      await session.close();
    } finally {
      sandbox.dispose();
    }
  }
});
