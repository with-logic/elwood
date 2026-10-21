/** Native Claude grouped and multiline answers through the public API (PRD §5.10). */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ClaudeSession,
  type ElwoodQuestionAnswer,
  type ElwoodQuestionEvent,
  type ElwoodQuestionRequest,
} from "../../src/index.ts";
import { claudeQuestionArtifacts } from "./questions/claude-artifacts.ts";
import { nativeClaudeQuestionSandbox } from "./questions/claude-sandbox.ts";

const groupedPrompt =
  'Call AskUserQuestion exactly once now with two questions: "Which test color?", header Color, options Amber (description Warm) and Blue (description Cool), single select; "Which test features?", header Features, options Logging (description Logs) and Metrics (description Counts), multiSelect true. After answers, reply exactly ELWOOD_GROUP_DONE. Do not inspect files or use any other tool. These are synthetic preferences that only the user can answer.';
const textPrompt =
  'Call AskUserQuestion exactly once now: "Which test note?", header Note, options Brief (description Short) and Detailed (description Long), single select. After the user answers, reply exactly ELWOOD_TEXT_DONE. Do not inspect files or use any other tool.';

test("C-E2E-18 native Claude grouped and free-text answers preserve the ergonomic turn", {
  skip:
    process.env["ELWOOD_NATIVE_QUESTIONS_PROOF"] === "1"
      ? existsSync(join(homedir(), ".local/bin/claude"))
        ? false
        : "requires pinned Claude and auth"
      : "set ELWOOD_NATIVE_QUESTIONS_PROOF=1 for two isolated valid-model turns",
  timeout: 240_000,
}, async (t) => {
  function selected(
    question: ElwoodQuestionRequest["questions"][number],
    labels: readonly string[],
  ) {
    return labels.map((label) => {
      const option = question.options.find((item) => item.label === label);
      assert.ok(option, `Native option ${label} must be present`);
      return option.id;
    });
  }

  const sandbox = await nativeClaudeQuestionSandbox();
  const events: ElwoodQuestionEvent[] = [];
  const normalized: ElwoodQuestionEvent[] = [];
  let next = Promise.withResolvers<ElwoodQuestionRequest>();
  let nativeAnswers: unknown;
  let unexpectedTools = 0;
  let primaryFailure = false;
  const facade = new ClaudeSession({
    cwd: sandbox.cwd,
    stateDir: sandbox.stateDir,
    model: "haiku",
    permissionMode: "default",
    autotrust: true,
    autoupdate: false,
    initialSize: { cols: 140, rows: 45 },
    hooks: {
      PreToolUse(event) {
        if (event.tool_name === "AskUserQuestion") return undefined;
        unexpectedTools++;
        return {
          permissionDecision: "deny",
          permissionDecisionReason: "Only questions in this proof.",
        };
      },
    },
  });
  const artifacts = claudeQuestionArtifacts(() => facade.session);
  facade.on("terminal:data", artifacts.observe);
  facade.on("question", (event) => {
    events.push(event);
    if (event.phase === "raised") next.resolve(event.request);
  });
  facade.on("activity", (event) => {
    if (event.kind === "question" && event.question) normalized.push(event.question);
  });
  facade.on("hook", (event) => {
    if (event.hook_event_name === "PostToolUse" && event.tool_name === "AskUserQuestion")
      nativeAnswers = event.tool_input.answers;
  });
  const abort = () => {
    void facade.kill();
  };
  t.signal.addEventListener("abort", abort, { once: true });
  async function round(
    prompt: string,
    answer: (request: ElwoodQuestionRequest) => readonly ElwoodQuestionAnswer[],
    expectedAnswers: unknown,
    final: string,
  ) {
    next = Promise.withResolvers<ElwoodQuestionRequest>();
    nativeAnswers = undefined;
    let settled = false;
    const reply = facade.send(prompt, { timeoutMs: 90_000 });
    void reply.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const request = await Promise.race([
      next.promise,
      reply.then(() => {
        throw new Error("Native turn completed without publishing its question");
      }),
    ]);
    assert.equal(settled, false, "Question must not finish the caller's turn");
    assert.deepEqual(await facade.listQuestions(), [request]);
    assert.ok(Object.isFrozen(request));
    assert.equal(request.delivery, "blocking");
    await facade.answerQuestions(request.id, answer(request), { timeoutMs: 30_000 });
    assert.deepEqual(nativeAnswers, expectedAnswers);
    assert.deepEqual(await facade.listQuestions(), []);
    assert.ok(
      events.some(
        (event) =>
          event.phase === "closed" &&
          event.request.id === request.id &&
          event.reason === "answered",
      ),
    );
    assert.equal((await reply).trim(), final);
  }
  try {
    const live = await facade.start();
    await live.waitForStatus((status) => status === "ready", 45_000);
    await round(
      groupedPrompt,
      (request) =>
        request.questions.map((question) => ({
          questionId: question.id,
          optionIds: selected(
            question,
            question.header === "Color" ? ["Blue"] : ["Logging", "Metrics"],
          ),
        })),
      { "Which test color?": "Blue", "Which test features?": "Logging, Metrics" },
      "ELWOOD_GROUP_DONE",
    );
    const note = "ELWOOD_NOTE_LINE1\nELWOOD_NOTE_LINE2";
    await round(
      textPrompt,
      (request) =>
        request.questions.map((question) => ({
          questionId: question.id,
          text: note,
        })),
      { "Which test note?": note },
      "ELWOOD_TEXT_DONE",
    );
    assert.deepEqual(normalized, events);
    assert.equal(unexpectedTools, 0);
    assert.equal(live.status, "ready");
    t.diagnostic(
      "Claude2.1.305: grouped single/multiple choices + multiline alternative text; native PostToolUse accepted both; original send returned final only.",
    );
  } catch (error) {
    primaryFailure = true;
    artifacts.failure(sandbox.writes, events);
    throw error;
  } finally {
    artifacts.save();
    try {
      await facade.kill();
    } finally {
      t.signal.removeEventListener("abort", abort);
      if (primaryFailure) {
        try {
          sandbox.dispose();
        } catch (error) {
          t.diagnostic(error instanceof Error ? error.message : "Sandbox cleanup failed");
        }
      } else sandbox.dispose();
      assert.equal(existsSync(sandbox.root), false);
    }
  }
});
