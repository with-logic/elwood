/** Grouped final Enter retains native ownership through acknowledgement or abort (PRD §4). */
import { expect, test } from "vitest";
import type { AskUserQuestionInput } from "../../../src/claude/hooks/tool-types.ts";
import { fixture, frame } from "./helpers.ts";
import { composer, nativeQuestions } from "./lifecycle-helpers.ts";
import { submissionHarness } from "./submission-helpers.ts";

function groupedFrames() {
  const logging = fixture("features-logging");
  return [
    fixture("features-initial"),
    logging,
    frame(logging.text.replace("❯ 1.", "  1.").replace("  2. [ ]", "❯ 2. [ ]")),
    frame(logging.text.replace("❯ 1.", "  1.").replace("  3. [ ]", "❯ 3. [ ]")),
    frame(fixture("features-submit-highlight").text.replace("2. [✔]", "2. [ ]")),
    frame(
      fixture("review")
        .text.replace("→ Blue", "→ Amber")
        .replace("→ Logging, Metrics", "→ Logging"),
    ),
    composer(),
  ];
}

test.each([
  "answered",
  "aborted",
] as const)("a grouped final Enter holds input until matching native closure (%s)", async (outcome) => {
  const h = submissionHarness(fixture("questions"), groupedFrames(), {
    questions: nativeQuestions,
  } satisfies AskUserQuestionInput);
  const cancellation = new AbortController();
  try {
    await h.start();
    const request = h.questions.list()[0]!;
    let finished = false;
    const pending = h.questions
      .answer(
        request.id,
        request.questions.map((question) => ({
          questionId: question.id,
          optionIds: [question.options[0]!.id],
        })),
        { signal: cancellation.signal },
      )
      .then(
        () => {
          finished = true;
          return "answered";
        },
        (error: unknown) => {
          finished = true;
          return error;
        },
      );
    await Promise.race([
      h.final,
      pending.then((outcome) => {
        if (outcome !== "answered") throw outcome;
        return h.final;
      }),
    ]);
    expect(h.writes).toEqual(["\r", " ", "\x1b[B", "\x1b[B", "\x1b[B", "\r", "\r"]);
    expect(h.questions.list()).toEqual([request]);
    expect(finished).toBe(false);
    expect(h.questions.blocksInput()).toBe(true);
    if (outcome === "aborted") {
      cancellation.abort();
      expect(await pending).toMatchObject({ code: "question_answer_failed" });
      expect(h.questions.list()).toEqual([]);
      expect(h.observed.at(-1)).toMatchObject({ phase: "closed", reason: "unavailable" });
      await expect(h.questions.answer(request.id, [])).rejects.toMatchObject({
        code: "question_not_found",
      });
    }
    h.hook("PostToolUse", { tool_use_id: "unrelated" });
    expect(h.questions.blocksInput()).toBe(true);
    h.hook("PostToolUse");
    if (outcome === "answered") {
      expect(await pending).toBe("answered");
      expect(h.observed.at(-1)).toMatchObject({ phase: "closed", reason: "answered", request });
    }
    expect(h.questions.blocksInput()).toBe(false);
    expect(h.writes).toHaveLength(7);
  } finally {
    h.dispose();
  }
});
