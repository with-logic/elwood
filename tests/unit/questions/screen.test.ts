/** Real captured Claude questionnaire grammar and conservative rejection (PRD §4). */
import { describe, expect, test } from "vitest";
import {
  claudeQuestionCandidate,
  parseClaudeQuestionScreen,
} from "../../../src/claude/questions/screen.ts";
import { definitions, fixture, frame, nativeSnapshot, registry } from "./helpers.ts";

const request = registry().publish("native", "blocking", definitions)!;
const captured = fixture("questions");
describe("native frames", () => {
  test.each([
    ["questions", 0, 0],
    ["color-blue-highlight", 0, 1],
    ["features-initial", 1, 0],
    ["features-logging", 1, 0],
    ["features-both", 1, 1],
    ["features-submit-highlight", 1, 3],
  ])("recognizes captured %s", (name, index, cursor) => {
    expect(parseClaudeQuestionScreen(fixture(String(name)), definitions)).toMatchObject({
      kind: "question",
      questionIndex: index,
      cursor,
    });
  });
  test("preserves checkbox state and native review cursor", () => {
    expect(parseClaudeQuestionScreen(fixture("features-both"), request.questions)).toMatchObject({
      checked: [true, true, false],
    });
    expect(parseClaudeQuestionScreen(fixture("review"), request.questions)).toEqual({
      kind: "review",
      cursor: 0,
      summary: "● Which test color? → Blue ● Which test features? → Logging, Metrics",
    });
    expect(
      parseClaudeQuestionScreen(
        frame(fixture("review").text.replace("❯ 1.", "  1.").replace("  2. Cancel", "❯ 2. Cancel")),
        request.questions,
      ),
    ).toEqual({
      kind: "review",
      cursor: 1,
      summary: "● Which test color? → Blue ● Which test features? → Logging, Metrics",
    });
  });
  test.each([
    (text) => text.replace("☐ Color", "☐ Other"),
    (text) => text.replace("Which test color?\n", "Unrelated question\n"),
    (text) => text.replace("Enter to select · Tab/Arrow keys to navigate · Esc to cancel", ""),
    (text) => `${text}\nUnrelated dialog`,
    (text) => text.replace("  2. Blue", "  9. Blue"),
    (text) => text.replace("  2. Blue", "  2. Green"),
    (text) => text.replace("     Warm", "     Unrecognized prose"),
    (text) => text.replace("❯ 1. Amber", "  1. Amber"),
    (text) => text.replace("❯ 1. Amber", "❯ 1. [ ] Amber"),
    (text) => text.replace("  3. Type something.", ""),
  ] satisfies readonly ((
    text: string,
  ) => string)[])("rejects changed or incomplete layout %#", (mutate) => {
    expect(
      parseClaudeQuestionScreen(frame(mutate(captured.text)), request.questions),
    ).toBeUndefined();
  });
  test("rejects a multi-select option without its checkbox markup", () => {
    const changed = fixture("features-initial").text.replace("❯ 1. [ ] Logging", "❯ 1. Logging");
    expect(parseClaudeQuestionScreen(frame(changed), request.questions)).toBeUndefined();
  });
  test("holds native partial questions but excludes ordinary composer quotations", () => {
    expect(
      claudeQuestionCandidate(captured.text.slice(0, captured.text.indexOf("Which test color?\n"))),
    ).toBe(true);
    expect(claudeQuestionCandidate(`${captured.text}\n❯ `)).toBe(false);
    expect(claudeQuestionCandidate("☐ Color\n❯ 1. Amber")).toBe(false);
    expect(
      parseClaudeQuestionScreen({ ...captured, cursorRow: 0 }, request.questions),
    ).toBeUndefined();
  });
  test("accepts the actual captured native Submit cursor parked at bottom-left", () => {
    expect(
      parseClaudeQuestionScreen(nativeSnapshot("features-submit-native"), request.questions),
    ).toMatchObject({ kind: "question", questionIndex: 1, cursor: 3 });
  });
  test("rejects partial rows, missing fences, malformed review and absent native headers", () => {
    const partial = captured.text.slice(0, captured.text.indexOf("Which test color?\n"));
    expect(parseClaudeQuestionScreen(frame(partial), request.questions)).toBeUndefined();
    const missingFence = captured.text.replace(/([─━]{3,})([\s\S]*?)([─━]{3,})/, "$1$2");
    expect(parseClaudeQuestionScreen(frame(missingFence), request.questions)).toBeUndefined();
    for (const change of [
      (text: string) => text.replace("  2. Cancel", ""),
      (text: string) => text.replace("❯ 1. Submit answers", "❯ 1. Delete answers"),
      (text: string) => text.replace("  2. Cancel", "  2. Delete"),
    ])
      expect(
        parseClaudeQuestionScreen(frame(change(fixture("review").text)), request.questions),
      ).toBeUndefined();
    const question = request.questions[0]!;
    const { header: _header, ...withoutHeader } = question;
    expect(parseClaudeQuestionScreen(captured, [withoutHeader])).toBeUndefined();
    expect(
      parseClaudeQuestionScreen({ ...captured, cursorRow: 100 }, request.questions),
    ).toBeUndefined();
    expect(
      parseClaudeQuestionScreen(nativeSnapshot("review-native"), request.questions),
    ).toMatchObject({
      kind: "review",
      cursor: 0,
      summary: "● Which test color? → Blue ● Which test features? → Logging, Metrics",
    });
  });
  test("rejects a missing/foreign checkbox Submit and supports options without descriptions", () => {
    for (const text of [
      fixture("features-submit-highlight").text.replace("❯    Submit", ""),
      fixture("features-submit-highlight").text.replace(
        "❯    Submit",
        "❯    Submit\n     Unexpected action",
      ),
    ])
      expect(parseClaudeQuestionScreen(frame(text), request.questions)).toBeUndefined();
    const withoutDescriptions = {
      ...request,
      questions: request.questions.map((question) => ({
        ...question,
        options: question.options.map(({ description: _description, ...option }) => option),
      })),
    };
    const plain = frame(captured.text.replace("     Warm\n", "").replace("     Cool\n", ""));
    expect(parseClaudeQuestionScreen(plain, withoutDescriptions.questions)).toMatchObject({
      kind: "question",
      cursor: 0,
    });
  });
  test("a review with a cursor outside native selection geometry has no answer authority", () => {
    expect(
      parseClaudeQuestionScreen(
        { ...nativeSnapshot("review-native"), cursorRow: 0, cursorY: 0 },
        request.questions,
      ),
    ).toBeUndefined();
  });
});
