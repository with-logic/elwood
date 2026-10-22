/** Native answers traverse captured stages without ordinary submission (PRD §4). */
import { describe, expect, test } from "vitest";
import { answerClaudeQuestions } from "../../../src/claude/questions/answer.ts";
import { definitions, fixture, frame, nativeSnapshot, registry } from "./helpers.ts";
import { scriptedQuestionIo as ioFor } from "./scripted-io.ts";

describe("Claude native answers", () => {
  test("answers grouped single choice, both checkboxes and verified final review", async () => {
    const request = registry().publish("native", "blocking", definitions)!;
    const logging = fixture("features-logging");
    const metricsCursor = frame(
      logging.text.replace("❯ 1.", "  1.").replace("  2. [ ]", "❯ 2. [ ]"),
    );
    const otherCursor = frame(
      fixture("features-both").text.replace("❯ 2.", "  2.").replace("  3. [ ]", "❯ 3. [ ]"),
    );
    const { io, writes } = ioFor(fixture("questions"), [
      fixture("color-blue-highlight"),
      fixture("features-initial"),
      logging,
      metricsCursor,
      fixture("features-both"),
      otherCursor,
      fixture("features-submit-highlight"),
      fixture("review"),
      fixture("answered"),
    ]);
    await answerClaudeQuestions(request, [{ optionIndexes: [1] }, { optionIndexes: [0, 1] }], io);
    expect(writes).toEqual(["\x1b[B", "\r", " ", "\x1b[B", " ", "\x1b[B", "\x1b[B", "\r", "\r"]);
  });
  test("pastes multiline Other before a single submitting Enter", async () => {
    const request = registry().publish("note", "blocking", [
      {
        ...definitions[0]!,
        prompt: "Which test note?",
        header: "Note",
        options: [
          { label: "Brief (short)", description: "A short test note." },
          { label: "Detailed (long)", description: "A long test note." },
        ],
      },
    ])!;
    const second = frame(
      fixture("freeform-questions")
        .text.replace("❯ 1.", "  1.")
        .replace("  2. Detailed", "❯ 2. Detailed"),
    );
    const { io, writes } = ioFor(fixture("freeform-questions"), [
      second,
      nativeSnapshot("freeform-other-highlight-native"),
      nativeSnapshot("freeform-other-typed-native"),
      fixture("freeform-answered"),
    ]);
    await answerClaudeQuestions(
      request,
      [{ optionIndexes: [], text: "ELWOOD_NOTE_LINE1\nELWOOD_NOTE_LINE2" }],
      io,
    );
    expect(writes).toEqual([
      "\x1b[B",
      "\x1b[B",
      "\x1b[200~ELWOOD_NOTE_LINE1\nELWOOD_NOTE_LINE2\x1b[201~",
      "\r",
    ]);
  });
  test("refuses human-navigated unsupported initial stages", async () => {
    const request = registry().publish("native", "blocking", definitions)!;
    const { io, writes } = ioFor(fixture("features-initial"), []);
    await expect(
      answerClaudeQuestions(request, [{ optionIndexes: [1] }, { optionIndexes: [0, 1] }], io),
    ).rejects.toMatchObject({ code: "question_answer_failed" });
    expect(writes).toEqual([]);
  });
  test("rejects unexpected Other selection and mismatched native review before submission", async () => {
    const request = registry().publish("native", "blocking", definitions)!;
    const unsupported = frame(
      fixture("features-both").text.replace("3. [ ] Type something", "3. [✔] custom"),
    );
    const first = ioFor(fixture("questions"), [fixture("color-blue-highlight"), unsupported]);
    await expect(
      answerClaudeQuestions(request, [{ optionIndexes: [1] }, { optionIndexes: [0, 1] }], first.io),
    ).rejects.toMatchObject({ code: "question_answer_failed" });
    expect(first.writes).toEqual(["\x1b[B", "\r"]);
    const logging = fixture("features-logging");
    const metricsCursor = frame(
      logging.text.replace("❯ 1.", "  1.").replace("  2. [ ]", "❯ 2. [ ]"),
    );
    const otherCursor = frame(
      fixture("features-both").text.replace("❯ 2.", "  2.").replace("  3. [ ]", "❯ 3. [ ]"),
    );
    const mismatch = ioFor(fixture("questions"), [
      fixture("color-blue-highlight"),
      fixture("features-initial"),
      logging,
      metricsCursor,
      fixture("features-both"),
      otherCursor,
      fixture("features-submit-highlight"),
      frame(fixture("review").text.replace("→ Blue", "→ Amber")),
    ]);
    await expect(
      answerClaudeQuestions(
        request,
        [{ optionIndexes: [1] }, { optionIndexes: [0, 1] }],
        mismatch.io,
      ),
    ).rejects.toMatchObject({ code: "question_answer_failed" });
    expect(mismatch.writes.filter((key) => key === "\r")).toHaveLength(2);
  });
  test("preserves selected choices and safely unchecks an unrequested checkbox", async () => {
    const request = registry().publish("native", "blocking", definitions)!;
    const metricsCursor = frame(
      fixture("features-logging").text.replace("❯ 1.", "  1.").replace("  2. [ ]", "❯ 2. [ ]"),
    );
    const otherCursor = frame(
      metricsCursor.text.replace("❯ 2.", "  2.").replace("  3. [ ]", "❯ 3. [ ]"),
    );
    const submit = frame(fixture("features-submit-highlight").text.replace("2. [✔]", "2. [ ]"));
    const review = frame(fixture("review").text.replace("→ Logging, Metrics", "→ Logging"));
    const { io, writes } = ioFor(fixture("questions"), [
      fixture("color-blue-highlight"),
      fixture("features-both"),
      metricsCursor,
      otherCursor,
      submit,
      review,
      fixture("answered"),
    ]);
    await answerClaudeQuestions(request, [{ optionIndexes: [1] }, { optionIndexes: [0] }], io);
    expect(writes).toEqual(["\x1b[B", "\r", " ", "\x1b[B", "\x1b[B", "\r", "\r"]);
  });
});
