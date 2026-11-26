/** A real Codex turn that ends with its queued question on screen settles (PRD §5.3, C-ATTN-02). */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexSession, type ElwoodQuestionEvent } from "../../src/index.ts";
import {
  publicCodexQuestionSandbox,
  waitForPublicCodexQuestion,
} from "./questions/codex-public-sandbox.ts";
import { questionCodexBinary, questionCodexModel } from "./questions/codex-sandbox.ts";

const prompt =
  'Use only request_user_input_async, exactly once, to ask exactly two questions: title "ELWOOD_END_SIZE: Which size?", options ["Small","Large"]; title "ELWOOD_END_COLOR: Which color?", options ["Amber","Blue"]. As soon as the first answer arrives, reply with exactly ELWOOD_END_DONE and nothing else, without waiting for the other answer. Do not inspect files, use other tools, or ask prose questions.';

test("C-ATTN-02 a Codex turn that ends with its queued question on screen settles at ready", {
  skip:
    process.env["ELWOOD_NATIVE_QUESTIONS_PROOF"] === "1"
      ? existsSync(questionCodexBinary) && existsSync(join(homedir(), ".codex/auth.json"))
        ? false
        : "requires pinned Codex and auth"
      : "set ELWOOD_NATIVE_QUESTIONS_PROOF=1 for two isolated valid-model turns",
  timeout: 180_000,
}, async () => {
  const sandbox = await publicCodexQuestionSandbox();
  const session = new CodexSession({
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
  const events: ElwoodQuestionEvent[] = [];
  const statuses: string[] = [];
  session.on("question", (event) => events.push(event));
  session.on("status", (event) => statuses.push(event.status));
  try {
    const live = await session.start();
    await live.waitForStatus((status) => status === "ready", 45_000);
    const reply = session.send(prompt, { timeoutMs: 60_000 });
    // Report the first failure, not the turn this test's cleanup ends.
    reply.catch(() => undefined);
    await waitForPublicCodexQuestion(() => events.filter((e) => e.phase === "raised").length === 2);
    const [size, color] = await session.listQuestions();
    assert.ok(size && color);
    const large = size.questions[0]?.options.find((option) => option.label === "Large");
    assert.ok(large);
    await session.answerQuestions(
      size.id,
      [{ questionId: size.questions[0]!.id, optionIds: [large.id] }],
      {
        timeoutMs: 30_000,
      },
    );
    // The model ends its turn with the color choice still open below the `? ` cells Codex
    // 0.172 drew under the prompt. Codex withdraws it, leaving that history above the idle
    // composer that must clear the queued panel's hold.
    assert.equal((await reply).trim(), "ELWOOD_END_DONE");
    assert.ok(statuses.includes("blocked"), `the queued panel never blocked: ${statuses}`);
    assert.equal(live.status, "ready");
    assert.deepEqual(
      events.filter((event) => event.phase === "closed").map((event) => event.reason),
      ["answered", "unavailable"],
    );
    assert.deepEqual(await session.listQuestions(), []);
    // The same composer takes the next prompt.
    const next = await session.send("Reply with exactly ELWOOD_END_AGAIN and nothing else.", {
      timeoutMs: 60_000,
    });
    assert.equal(next.trim(), "ELWOOD_END_AGAIN");
  } finally {
    await session.close();
    sandbox.dispose();
  }
});
