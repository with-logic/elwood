/** Real Codex questions answered in a pane too narrow for their layout (PRD §5.10, C-QUESTION-04). */
import assert from "node:assert/strict";
import test from "node:test";
import type { CodexSession, ElwoodQuestionEvent } from "../../src/index.ts";
import { asyncPrompt, modalPrompt } from "./questions/codex-prompts.ts";
import { publicCodexModalAnswers } from "./questions/codex-public-answers.ts";
import {
  publicCodexOptionAnswer,
  publicCodexQuestionSandbox,
  publicCodexQuestionSession,
  publicCodexTextAnswer,
  waitForPublicCodexQuestion,
  waitForPublicCodexQuestionBefore,
} from "./questions/codex-public-sandbox.ts";
import { codexQuestionProofSkip } from "./questions/codex-sandbox.ts";
import { runPublicProof } from "./questions/proof-run.ts";

type Live = Awaited<ReturnType<CodexSession["start"]>>;
const footerRows = (live: Live) =>
  live.terminal
    .snapshot()
    .lines.map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(-2);
const closed = (events: readonly ElwoodQuestionEvent[]) =>
  events.flatMap((event) => (event.phase === "closed" ? [[event.request.id, event.reason]] : []));

test("C-QUESTION-04 queued Codex questions are answered in a 50-column pane", {
  skip: codexQuestionProofSkip("one valid-model turn"),
  timeout: 240_000,
}, async (t) => {
  const sandbox = await publicCodexQuestionSandbox();
  const session = publicCodexQuestionSession(sandbox, { cols: 50, rows: 45 });
  const events: ElwoodQuestionEvent[] = [];
  session.on("question", (event) => events.push(event));
  await runPublicProof(t, [() => session.close(), () => sandbox.dispose()], async () => {
    const live = await session.start();
    await live.waitForStatus((status) => status === "ready", 45_000);
    const reply = session.send(asyncPrompt, { timeoutMs: 90_000 });
    // If a step below fails, cleanup's close() rejects this send; handle that rejection here so
    // the runner reports the failed step.
    reply.catch(() => undefined);
    const raised = () => events.filter((event) => event.phase === "raised").length === 3;
    await waitForPublicCodexQuestionBefore(raised, reply);
    const [color, note, literal] = await session.listQuestions();
    assert.ok(color && note && literal);
    await session.answerQuestions(color.id, [publicCodexOptionAnswer(color, "Blue")], {
      timeoutMs: 30_000,
    });
    // Codex shows the note next, as 1 of 2. At 50 columns 0.172 moves its last footer hint to a
    // row of its own, and that editor must still hold ordinary input.
    const wrapped = ["enter submit   ⌃] skip   ⇧→ main prompt", "⇧← next question"];
    await waitForPublicCodexQuestion(() => footerRows(live).join("\n") === wrapped.join("\n"));
    await live.waitForStatus((status) => status === "blocked", 5_000);
    assert.deepEqual(await session.listQuestions(), [note, literal]);
    await session.answerQuestions(note.id, [publicCodexTextAnswer(note, "narrow note")], {
      timeoutMs: 30_000,
    });
    await session.answerQuestions(literal.id, [publicCodexTextAnswer(literal, "narrow literal")], {
      timeoutMs: 30_000,
    });
    assert.equal((await reply).trim(), "ELWOOD_ASYNC_DONE");
    assert.deepEqual(closed(events), [
      [color.id, "answered"],
      [note.id, "answered"],
      [literal.id, "answered"],
    ]);
  });
});

// Codex 0.172 fits as many modal footer hints on a row as it can. At 50 columns it also wraps
// the description of "None of the above", which the answers select, and the notes footer.
const modalPanes = [
  {
    cols: 80,
    footer: [
      "tab to add notes | enter to submit answer | ←/→ to navigate questions",
      "esc to interrupt",
    ],
  },
  {
    cols: 50,
    footer: [
      "tab to add notes | enter to submit answer",
      "←/→ to navigate questions | esc to interrupt",
    ],
  },
];

for (const { cols, footer } of modalPanes) {
  test(`C-QUESTION-04 a modal Codex question is answered in a pane ${cols} columns wide`, {
    skip: codexQuestionProofSkip("one valid-model turn"),
    timeout: 240_000,
  }, async (t) => {
    const sandbox = await publicCodexQuestionSandbox();
    const session = publicCodexQuestionSession(sandbox, { cols, rows: 45 });
    const events: ElwoodQuestionEvent[] = [];
    session.on("question", (event) => events.push(event));
    await runPublicProof(t, [() => session.close(), () => sandbox.dispose()], async () => {
      const live = await session.start();
      await live.waitForStatus((status) => status === "ready", 45_000);
      await live.sendKeys("/plan");
      await waitForPublicCodexQuestion(() =>
        /^›\s*\/plan\s*$/m.test(live.terminal.snapshot().text),
      );
      await live.sendKeys("\r");
      // A narrow pane elides the hint row's `Plan mode (shift+tab to cycle)` badge; the transcript
      // still says the model changed for Plan mode.
      await waitForPublicCodexQuestion(() => live.terminal.snapshot().text.includes("Plan mode"));
      const reply = session.send(modalPrompt, { timeoutMs: 90_000 });
      reply.catch(() => undefined);
      await waitForPublicCodexQuestionBefore(() => events.length === 1, reply);
      await waitForPublicCodexQuestion(() => footerRows(live).join("\n") === footer.join("\n"));
      await live.waitForStatus((status) => status === "blocked", 5_000);
      const [request] = await session.listQuestions();
      assert.ok(request);
      assert.equal(request.delivery, "blocking");
      assert.equal(request.questions.length, 3);
      await session.answerQuestions(request.id, publicCodexModalAnswers(request, "narrow note"), {
        timeoutMs: 30_000,
      });
      assert.equal((await reply).trim(), "ELWOOD_MODAL_DONE");
      assert.deepEqual(closed(events), [[request.id, "answered"]]);
    });
  });
}
