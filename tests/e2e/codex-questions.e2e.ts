/** Public native Codex queued and modal question round trips (PRD §5.10, §7A). */
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { record } from "../../src/core/activity/meta.ts";
import { CodexSession, type ElwoodQuestionEvent } from "../../src/index.ts";
import { nativeCodexFunctionOutput } from "./questions/codex-observer.ts";
import {
  publicCodexBlueAnswer as blue,
  captureCodexQuestionCursor,
  publicCodexQuestionRecords,
  publicCodexQuestionSandbox,
  waitForPublicCodexQuestion as waitFor,
} from "./questions/codex-public-sandbox.ts";
import { questionCodexBinary, questionCodexModel } from "./questions/codex-sandbox.ts";

const asyncPrompt =
  'Use only request_user_input_async, exactly once, to ask two questions: title "ELWOOD_ASYNC_COLOR: Which color?", options ["Amber","Blue"]; title "ELWOOD_ASYNC_NOTE: What note?", no options. Keep reasoning silently about the first 150 primes until both answers arrive. Then report both exact answers and ELWOOD_ASYNC_DONE in a final answer. Do not inspect files, use other tools, or ask prose questions.';
const modalPrompt =
  'You are now in Plan mode. Call the BLOCKING request_user_input tool exactly once. Do NOT call request_user_input_async: this turn must use the synchronous modal questionnaire, not the queued tool from the previous turn. Ask two questions: id "color", header "Color", question "ELWOOD_MODAL_COLOR: Which color?", options Amber(description Warm) and Blue(description Cool); id "note", header "Note", question "ELWOOD_MODAL_NOTE: What note?", options Standard(description Default) and Short(description Brief). All questions require nonempty options. Wait for answers then report both exact answers and ELWOOD_MODAL_DONE. Do not inspect files, use other tools, or ask prose questions.';

test("C-E2E-19 native Codex queued and grouped answers preserve the caller turn", {
  skip:
    process.env["ELWOOD_NATIVE_QUESTIONS_PROOF"] === "1"
      ? existsSync(questionCodexBinary) && existsSync(join(homedir(), ".codex/auth.json"))
        ? false
        : "requires pinned Codex and auth"
      : "set ELWOOD_NATIVE_QUESTIONS_PROOF=1 for two isolated valid-model turns",
  timeout: 240_000,
}, async (t) => {
  const sandbox = await publicCodexQuestionSandbox();
  const create = () =>
    new CodexSession({
      cwd: sandbox.cwd,
      stateDir: sandbox.stateDir,
      model: questionCodexModel,
      reasoningEffort: "low",
      autotrust: true,
      autoupdate: false,
      sandbox: "read-only",
      approvalPolicy: "never",
      initialSize: { cols: 140, rows: 45 },
    });
  let facade = create();
  const events: ElwoodQuestionEvent[] = [];
  const messages: string[] = [];
  let primaryFailure = false;
  const normalized: ElwoodQuestionEvent[] = [];
  function subscribe() {
    facade.on("question", (event) => events.push(event));
    facade.on("activity", (event) => {
      if (event.kind === "assistant_message" && event.text) messages.push(event.text);
      if (event.kind === "question" && event.question) normalized.push(event.question);
    });
  }
  subscribe();
  const abort = () => {
    void facade.kill();
  };
  t.signal.addEventListener("abort", abort, { once: true });
  try {
    let live = await facade.start();
    captureCodexQuestionCursor(live.terminal, sandbox.root);
    await live.waitForStatus((status) => status === "ready", 45_000);
    let settled = false;
    const reply = facade.send(asyncPrompt, { timeoutMs: 90_000 });
    void reply.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await waitFor(() => events.filter((event) => event.phase === "raised").length === 2);
    const requests = await facade.listQuestions();
    assert.equal(requests.length, 2);
    assert.ok(
      requests.every((request) => request.delivery === "queued" && request.questions.length === 1),
    );
    assert.equal(settled, false);
    assert.equal(live.status, "running");
    await facade.answerQuestions(
      requests[1]!.id,
      [
        {
          questionId: requests[1]!.questions[0]!.id,
          text: "ELWOOD_API_NOTE_93",
        },
      ],
      { timeoutMs: 30_000 },
    );
    assert.deepEqual(await facade.listQuestions(), [requests[0]]);
    await facade.answerQuestions(requests[0]!.id, [blue(requests[0]!)], { timeoutMs: 30_000 });
    assert.match(await reply, /ELWOOD_ASYNC_DONE/);
    assert.deepEqual(await facade.listQuestions(), []);
    assert.ok(!messages.some((text) => text.includes("ELWOOD_ASYNC_COLOR:")));
    const userText = publicCodexQuestionRecords(sandbox.home)
      .flatMap((item) => {
        const payload = record(record(item)["payload"]);
        return payload["role"] === "user" ? JSON.stringify(payload["content"]) : [];
      })
      .filter((text) => text.includes("<send_user_message_question_reply>"));
    assert.equal(userText.length, 2);
    assert.match(userText[0]!, /ELWOOD_API_NOTE_93/);
    assert.match(userText[1]!, /Blue/);
    await facade.kill();
    facade = create();
    subscribe();
    live = await facade.start();
    await live.waitForStatus((status) => status === "ready", 45_000);
    await live.sendKeys("/plan");
    // Raw keys bypass the ordinary native paste-burst guard.
    await delay(200);
    await live.sendKeys("\r");
    await waitFor(() => live.terminal.snapshot().text.includes("Plan mode ("));
    const before = events.length;
    const modalReply = facade.send(modalPrompt, { timeoutMs: 90_000 });
    void modalReply.catch(() => undefined);
    await waitFor(() => events.slice(before).some((event) => event.phase === "raised"));
    const [modal] = await facade.listQuestions();
    assert.ok(modal);
    assert.equal(modal.delivery, "blocking");
    assert.equal(modal.questions.length, 2);
    const answers = modal.questions.map((question) => {
      const label = question.header === "Color" ? "None of the above" : "Short";
      const option = question.options.find((item) => item.label === label);
      assert.ok(option);
      return {
        questionId: question.id,
        optionIds: [option.id],
        ...(question.header === "Color" ? {} : { text: "ELWOOD_API_MODAL_16" }),
      };
    });
    await facade.answerQuestions(modal.id, answers, { timeoutMs: 30_000 });
    assert.match(await modalReply, /ELWOOD_MODAL_DONE/);
    const output = nativeCodexFunctionOutput(
      publicCodexQuestionRecords(sandbox.home).map(record),
      "request_user_input",
    );
    assert.equal(typeof output, "string");
    assert.deepEqual(JSON.parse(String(output)), {
      answers: {
        color: { answers: ["None of the above"] },
        note: { answers: ["Short", "user_note: ELWOOD_API_MODAL_16"] },
      },
    });

    assert.deepEqual(await facade.listQuestions(), []);
    assert.equal(
      events.filter((event) => event.phase === "closed" && event.reason === "answered").length,
      3,
    );
    assert.deepEqual(normalized, events);
    assert.equal(live.status, "ready");
    t.diagnostic(
      "Codex0.163.0: queued answers accepted independently via committed reply envelopes; Plan modal accepted whole set; original send completed only on final.",
    );
  } catch (error) {
    primaryFailure = true;
    if (facade.session)
      writeFileSync(
        "/tmp/elwood-codex-question-public-failure.json",
        JSON.stringify({
          snapshot: facade.session.terminal.snapshot(),
          writes: sandbox.writes,
          status: facade.status,
          title: facade.session.terminal.title,
          events,
          records: publicCodexQuestionRecords(sandbox.home),
        }),
      );
    throw error;
  } finally {
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
