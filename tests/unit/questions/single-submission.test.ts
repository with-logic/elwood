/** Single-question final submission shares native completion ownership (PRD §4). */
import { expect, test, vi } from "vitest";
import type { AskUserQuestionInput } from "../../../src/claude/hooks/tool-types.ts";
import { fixture } from "./helpers.ts";
import { composer } from "./lifecycle-helpers.ts";
import { submissionHarness } from "./submission-helpers.ts";

const toolInput = {
  questions: [
    {
      question: "Which test note?",
      header: "Note",
      multiSelect: false,
      options: [
        { label: "Brief (short)", description: "A short test note." },
        { label: "Detailed (long)", description: "A long test note." },
      ],
    },
  ] satisfies AskUserQuestionInput["questions"],
} satisfies AskUserQuestionInput;

test("a single final Enter stays pending until its native completion", async () => {
  const h = submissionHarness(fixture("freeform-questions"), [composer()], toolInput);
  try {
    await h.start();
    const request = h.questions.list()[0]!;
    let finished = false;
    const pending = h.questions
      .answer(request.id, [
        { questionId: request.questions[0]!.id, optionIds: [request.questions[0]!.options[0]!.id] },
      ])
      .then(
        () => {
          finished = true;
          return "resolved";
        },
        (error: unknown) => {
          finished = true;
          return error;
        },
      );
    await Promise.race([
      h.final,
      pending.then((outcome) => {
        if (outcome !== "resolved") throw outcome;
        return h.final;
      }),
    ]);
    expect(h.writes).toEqual(["\r"]);
    expect(h.questions.list()).toEqual([request]);
    expect(finished).toBe(false);
    h.hook("PostToolUse");
    expect(await pending).toBe("resolved");
    expect(h.observed.at(-1)).toMatchObject({ phase: "closed", reason: "answered", request });
  } finally {
    h.dispose();
  }
});

test("a failed simulated render rejects final synchronization and still disposes the session", async () => {
  const h = submissionHarness(fixture("freeform-questions"), [composer()], toolInput);
  let pending: Promise<unknown> | undefined;
  try {
    await h.start();
    const renderFailure = new Error("simulated composer render failed");
    vi.spyOn(h.terminal, "writeOutput").mockRejectedValueOnce(renderFailure);
    const request = h.questions.list()[0]!;
    pending = h.questions
      .answer(request.id, [
        {
          questionId: request.questions[0]!.id,
          optionIds: [request.questions[0]!.options[0]!.id],
        },
      ])
      .catch((error: unknown) => error);
    await expect(h.final).rejects.toBe(renderFailure);
  } finally {
    h.dispose();
    await pending;
  }
});
