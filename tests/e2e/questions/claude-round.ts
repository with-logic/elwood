/** Keep each native question answer inside its original ergonomic turn (C-E2E-18). */
import type { TestContext } from "node:test";
import type {
  AskUserQuestionInput,
  ClaudeSession,
  ElwoodQuestionAnswer,
  ElwoodQuestionEvent,
  ElwoodQuestionRequest,
} from "../../../src/index.ts";
import { claudeAnswerTimeoutMs, claudeTurnTimeoutMs } from "./claude-cases.ts";

export function claudeQuestionRounds(
  facade: ClaudeSession,
  events: readonly ElwoodQuestionEvent[],
  context: Pick<TestContext, "assert" | "signal">,
) {
  const { signal } = context;
  let next = Promise.withResolvers<ElwoodQuestionRequest>();
  let nativeAnswers: AskUserQuestionInput["answers"];
  const finalMessages: string[] = [];
  facade.on("question", (event) => {
    if (event.phase === "raised") next.resolve(event.request);
  });
  facade.on("hook", (event) => {
    if (event.hook_event_name === "PostToolUse" && event.tool_name === "AskUserQuestion")
      nativeAnswers = event.tool_input.answers;
  });
  facade.on("activity", (event) => {
    if (event.kind === "assistant_message" && event.text !== undefined)
      finalMessages.push(event.text);
  });
  return async (
    prompt: string,
    answer: (request: ElwoodQuestionRequest) => readonly ElwoodQuestionAnswer[],
    expectedAnswers: NonNullable<AskUserQuestionInput["answers"]>,
    final: string,
  ): Promise<string> => {
    signal.throwIfAborted();
    next = Promise.withResolvers<ElwoodQuestionRequest>();
    nativeAnswers = undefined;
    finalMessages.length = 0;
    let settled = false;
    const reply = facade.send(prompt, { timeoutMs: claudeTurnTimeoutMs });
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
    context.assert.equal(settled, false, "Question must not finish the caller's turn");
    context.assert.deepEqual(await facade.listQuestions(), [request]);
    context.assert.ok(Object.isFrozen(request));
    context.assert.equal(request.delivery, "blocking");
    signal.throwIfAborted();
    await facade.answerQuestions(request.id, answer(request), {
      timeoutMs: claudeAnswerTimeoutMs,
      signal,
    });
    context.assert.deepEqual(nativeAnswers, expectedAnswers);
    context.assert.deepEqual(await facade.listQuestions(), []);
    context.assert.ok(
      events.some(
        (event) =>
          event.phase === "closed" &&
          event.request.id === request.id &&
          event.reason === "answered",
      ),
    );
    const result = await reply;
    const finalMessage = finalMessages.at(-1);
    context.assert.ok(finalMessage, "Final assistant activity must be captured");
    context.assert.equal(
      result,
      finalMessage,
      "send() must return the captured final assistant message",
    );
    context.assert.ok(result.includes(final), "Final reply must contain its sentinel");
    for (const submitted of Object.values(expectedAnswers))
      context.assert.notEqual(result.trim(), submitted);
    return request.id;
  };
}
