/** Real Codex queued questions answered in a narrow pane (PRD §5.10, C-QUESTION-04). */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexSession, type ElwoodQuestionEvent } from "../../src/index.ts";
import {
  publicCodexBlueAnswer,
  publicCodexQuestionSandbox,
  waitForPublicCodexQuestion,
} from "./questions/codex-public-sandbox.ts";
import { questionCodexBinary, questionCodexModel } from "./questions/codex-sandbox.ts";

const prompt =
  'Use only request_user_input_async, exactly once, to ask exactly two questions: title "ELWOOD_NARROW_COLOR: Which color?", options ["Amber","Blue"]; title "ELWOOD_NARROW_NOTE: What note?", no options. Keep reasoning silently about the first 150 primes until both answers arrive. Then reply with exactly ELWOOD_NARROW_DONE and nothing else. Do not inspect files, use other tools, or ask prose questions.';

test("C-QUESTION-04 queued Codex questions are answered in a 50-column pane", {
  skip:
    process.env["ELWOOD_NATIVE_QUESTIONS_PROOF"] === "1"
      ? existsSync(questionCodexBinary) && existsSync(join(homedir(), ".codex/auth.json"))
        ? false
        : "requires pinned Codex and auth"
      : "set ELWOOD_NATIVE_QUESTIONS_PROOF=1 for two isolated valid-model turns",
  timeout: 180_000,
}, async () => {
  const sandbox = await publicCodexQuestionSandbox();
  // At 50 columns Codex 0.172 wraps the queued panel's footer hints onto a second row.
  const session = new CodexSession({
    cwd: sandbox.cwd,
    stateDir: sandbox.stateDir,
    model: questionCodexModel,
    reasoningEffort: "low",
    autotrust: true,
    autoupdate: false,
    sandbox: "read-only",
    approvalPolicy: "never",
    initialSize: { cols: 50, rows: 45 },
  });
  const events: ElwoodQuestionEvent[] = [];
  session.on("question", (event) => events.push(event));
  try {
    const live = await session.start();
    await live.waitForStatus((status) => status === "ready", 45_000);
    const reply = session.send(prompt, { timeoutMs: 90_000 });
    // Report the first failure, not the turn this test's cleanup ends.
    reply.catch(() => undefined);
    await waitForPublicCodexQuestion(() => events.filter((e) => e.phase === "raised").length === 2);
    const [color, note] = await session.listQuestions();
    assert.ok(color && note);
    await session.answerQuestions(color.id, [publicCodexBlueAnswer(color)], { timeoutMs: 30_000 });
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
    await session.close();
    sandbox.dispose();
  }
});
