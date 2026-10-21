/** Separate queued and Plan-modal public question sessions (PRD §12, C-E2E-19). */
// biome-ignore-all lint/suspicious/noMisplacedAssertion: Native proof phases own these assertions.
import assert from "node:assert/strict";
import type { CodexSession, ElwoodQuestionEvent } from "../../../src/index.ts";
import type { ElwoodTerminal } from "../../../src/terminal/headless.ts";
import { asyncPrompt, modalPrompt } from "./codex-prompts.ts";
import {
  assertPublicCodexModalAnswers,
  assertPublicCodexQueuedAnswers,
  publicCodexModalAnswers,
  queuedLiteralAnswer,
} from "./codex-public-answers.ts";
import {
  publicCodexBlueAnswer,
  publicCodexQuestionRecords,
  type publicCodexQuestionSandbox,
  waitForPublicCodexQuestion as waitFor,
} from "./codex-public-sandbox.ts";

type Phase = {
  readonly facade: CodexSession;
  readonly sandbox: Awaited<ReturnType<typeof publicCodexQuestionSandbox>>;
  readonly events: readonly ElwoodQuestionEvent[];
  readonly signal: AbortSignal;
  readonly note: { readonly text: string; readonly accepted: string };
};

/** A turn must raise its expected questions before it can finish or fail. */
async function waitBeforeReply(check: () => boolean, reply: Promise<string>, signal: AbortSignal) {
  const waiting = new AbortController();
  const abort = () => waiting.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    await Promise.race([
      waitFor(check, waiting.signal),
      reply.then(() => {
        if (!check()) throw new Error("Native turn finished before raising expected questions");
      }),
    ]);
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", abort);
    waiting.abort();
  }
}

export async function publicCodexQueuedPhase(
  input: Phase & {
    readonly messages: readonly string[];
    readonly capture: (terminal: ElwoodTerminal) => void;
  },
): Promise<readonly string[]> {
  const { facade, sandbox, events, signal, note } = input;
  signal.throwIfAborted();
  const live = await facade.start();
  signal.throwIfAborted();
  input.capture(live.terminal);
  await live.waitForStatus((status) => status === "ready", 45_000);
  signal.throwIfAborted();
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
  await waitBeforeReply(
    () => events.filter((event) => event.phase === "raised").length === 3,
    reply,
    signal,
  );
  const requests = await facade.listQuestions();
  assert.equal(requests.length, 3);
  assert.ok(
    requests.every((request) => request.delivery === "queued" && request.questions.length === 1),
  );
  assert.equal(settled, false);
  assert.equal(live.status, "running");
  await facade.answerQuestions(
    requests[1]!.id,
    [{ questionId: requests[1]!.questions[0]!.id, text: note.text }],
    { timeoutMs: 30_000 },
  );
  assert.deepEqual(await facade.listQuestions(), [requests[0], requests[2]]);
  assert.equal(settled, false);
  assert.equal(live.status, "running");
  signal.throwIfAborted();
  await facade.answerQuestions(
    requests[2]!.id,
    [{ questionId: requests[2]!.questions[0]!.id, text: queuedLiteralAnswer }],
    { timeoutMs: 30_000 },
  );
  assert.deepEqual(await facade.listQuestions(), [requests[0]]);
  assert.equal(settled, false);
  assert.equal(live.status, "running");
  signal.throwIfAborted();
  await facade.answerQuestions(requests[0]!.id, [publicCodexBlueAnswer(requests[0]!)], {
    timeoutMs: 30_000,
  });
  assert.equal((await reply).trim(), "ELWOOD_ASYNC_DONE");
  assert.deepEqual(await facade.listQuestions(), []);
  assert.ok(!input.messages.some((text) => text.includes("ELWOOD_ASYNC_COLOR:")));
  assertPublicCodexQueuedAnswers(publicCodexQuestionRecords(sandbox.home), note.accepted);
  return [requests[1]!.id, requests[2]!.id, requests[0]!.id];
}

export async function publicCodexModalPhase(input: Phase): Promise<string> {
  const { facade, sandbox, events, signal, note } = input;
  signal.throwIfAborted();
  const live = await facade.start();
  signal.throwIfAborted();
  await live.waitForStatus((status) => status === "ready", 45_000);
  signal.throwIfAborted();
  await live.sendKeys("/plan");
  await waitFor(() => /^›\s*\/plan\s*$/m.test(live.terminal.snapshot().text), signal);
  await live.sendKeys("\r");
  await waitFor(() => live.terminal.snapshot().text.includes("Plan mode ("), signal);
  signal.throwIfAborted();
  const before = events.length;
  const reply = facade.send(modalPrompt, { timeoutMs: 90_000 });
  await waitBeforeReply(
    () => events.slice(before).some((event) => event.phase === "raised"),
    reply,
    signal,
  );
  const [request] = await facade.listQuestions();
  assert.ok(request);
  assert.equal(request.delivery, "blocking");
  assert.equal(request.questions.length, 3);
  signal.throwIfAborted();
  await facade.answerQuestions(request.id, publicCodexModalAnswers(request, note.text), {
    timeoutMs: 30_000,
  });
  assert.equal((await reply).trim(), "ELWOOD_MODAL_DONE");
  assertPublicCodexModalAnswers(publicCodexQuestionRecords(sandbox.home), note.accepted);
  assert.deepEqual(await facade.listQuestions(), []);
  assert.equal(live.status, "ready");
  return request.id;
}
