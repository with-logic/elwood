/** A real Codex turn that ends with its queued question on screen settles (PRD §5.3, C-ATTN-02). */
import assert from "node:assert/strict";
import test from "node:test";
import type { ElwoodQuestionEvent, ElwoodSessionStatus } from "../../src/index.ts";
import { turnEndPrompt } from "./questions/codex-prompts.ts";
import {
  publicCodexOptionAnswer,
  publicCodexQuestionSandbox,
  publicCodexQuestionSession,
  waitForPublicCodexQuestionsBeforeReply,
} from "./questions/codex-public-sandbox.ts";
import { codexQuestionProofSkip } from "./questions/codex-sandbox.ts";
import { runPublicProof } from "./questions/proof-run.ts";

test("C-ATTN-02 a Codex turn that ends with its queued question on screen settles at ready", {
  skip: codexQuestionProofSkip("two valid-model turns in one session"),
  timeout: 180_000,
}, async (t) => {
  const sandbox = await publicCodexQuestionSandbox();
  const session = publicCodexQuestionSession(sandbox);
  const events: ElwoodQuestionEvent[] = [];
  const statuses: ElwoodSessionStatus[] = [];
  session.on("question", (event) => events.push(event));
  session.on("status", (event) => statuses.push(event.status));
  await runPublicProof(t, [() => session.close(), () => sandbox.dispose()], async () => {
    const live = await session.start();
    await live.waitForStatus((status) => status === "ready", 45_000);
    const reply = session.send(turnEndPrompt, { timeoutMs: 60_000 });
    // If a step below fails, cleanup's close() rejects this send; handle that rejection here so
    // the runner reports the failed step.
    reply.catch(() => undefined);
    const raised = () => events.filter((event) => event.phase === "raised").length === 2;
    await waitForPublicCodexQuestionsBeforeReply(raised, reply);
    const [size, color] = await session.listQuestions();
    assert.ok(size && color);
    await session.answerQuestions(size.id, [publicCodexOptionAnswer(size, "Large")], {
      timeoutMs: 30_000,
    });
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
    // A reply cell under the prompt would bound it without the `? ` cells this proof is for.
    const lines = live.terminal.snapshot().lines.map((line) => line.trimEnd());
    const prompt = lines.findIndex((line) =>
      line.startsWith("› Use only request_user_input_async"),
    );
    const below = lines.slice(prompt + 1).find((line) => line !== "" && !line.startsWith(" "));
    assert.ok(prompt >= 0 && below?.startsWith("? ELWOOD_END_SIZE"), lines.join("\n"));
    // The same composer takes the next prompt.
    const next = await session.send("Reply with exactly ELWOOD_END_AGAIN and nothing else.", {
      timeoutMs: 60_000,
    });
    assert.equal(next.trim(), "ELWOOD_END_AGAIN");
  });
});
