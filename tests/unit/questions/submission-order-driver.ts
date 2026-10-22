/** Real Claude input/render driver with failures observed through QuestionIo (PRD §4). */
import { ClaudeQuestionAdapter } from "../../../src/claude/questions/index.ts";
import type { QuestionAdapter } from "../../../src/core/questions/adapter.ts";
import type { ElwoodQuestionEvent } from "../../../src/core/questions/types.ts";
import { controllerHarness, paintQuestionFrame } from "./controller-helpers.ts";
import { groupedAnswerFrames } from "./grouped-frame-helpers.ts";
import { fixture } from "./helpers.ts";
import { composer, nativeHook } from "./lifecycle-helpers.ts";

export type SubmissionScenario = {
  readonly acknowledgementOrder: "composer-first" | "hook-first";
  readonly abortAfterFinalRender?: true;
  readonly failure?: "input" | "first-render" | "last-render";
};
export function submissionOrderDriver(scenario: SubmissionScenario) {
  const successors = [...groupedAnswerFrames(), composer()];
  const finalRender = Promise.withResolvers<void>();
  const observed: ElwoodQuestionEvent[] = [];
  const renderFailures: unknown[] = [];
  const injectedRenderFailure = new Error("Synthetic native render rejection");
  let rendered = Promise.resolve();
  let inputWriteCount = 0;
  const h = controllerHarness({ onInput });
  function onInput(): void {
    inputWriteCount++;
    if (scenario.failure === "input") throw new Error("Synthetic terminal input failure");
    const next = successors[inputWriteCount - 1];
    if (!next) throw new Error("Unexpected extra answer write");
    const isFinalInput = inputWriteCount === successors.length;
    if (isFinalInput && scenario.acknowledgementOrder === "hook-first")
      h.events.emit("activity", nativeHook("PostToolUse"));
    const rejectsRender =
      scenario.failure === "first-render" || (isFinalInput && scenario.failure === "last-render");
    rendered = rejectsRender
      ? Promise.reject(injectedRenderFailure)
      : paintQuestionFrame(h.terminal, next);
    void rendered.then(
      () => {
        if (isFinalInput) finalRender.resolve();
      },
      (error: unknown) => {
        renderFailures.push(error);
      },
    );
  }
  h.events.on("question", (event) => observed.push(event));
  h.questions.configure((requests) => {
    const adapter = new ClaudeQuestionAdapter(requests);
    if (scenario.failure !== "first-render" && scenario.failure !== "last-render") return adapter;
    // The native render failure must reject the adapter operation, not merely a test barrier.
    const withRenderedWrites: QuestionAdapter = {
      observe: (event) => adapter.observe(event),
      render: (frame) => adapter.render(frame),
      blocksInput: () => adapter.blocksInput(),
      answer: (request, answers, io) =>
        adapter.answer(request, answers, {
          ...io,
          write: async (...args) => {
            await io.write(...args);
            await rendered;
          },
        }),
    };
    return withRenderedWrites;
  });
  return {
    h,
    observed,
    renderFailures,
    injectedRenderFailure,
    finalRender: finalRender.promise,
    inputWriteCount: () => inputWriteCount,
    expectedInputWriteCount: successors.length,
    start: async () => {
      h.events.emit("activity", nativeHook());
      await paintQuestionFrame(h.terminal, fixture("questions"));
    },
  };
}
