/** Standalone Claude checkbox layouts and their native submission stages (PRD §5.10, C-QUESTION-03). */
import { expect, test } from "vitest";
import { answerClaudeQuestions } from "../../../src/claude/questions/answer.ts";
import { parseClaudeQuestionScreen } from "../../../src/claude/questions/screen.ts";
import { arrowDown, arrowUp } from "../../../src/core/input/constants.ts";
import type { QuestionFrame } from "../../../src/core/questions/adapter.ts";
import { questionAnswerFailed } from "../../../src/core/questions/errors.ts";
import { paintQuestionFrame } from "./controller-helpers.ts";
import { fixture, frame, registry, testPick } from "./helpers.ts";
import { scriptedQuestionIo } from "./scripted-io-helpers.ts";
import { submissionHarness } from "./submission-helpers.ts";

const toolQuestion = {
  question: "Which fruits?",
  header: "Repos",
  multiSelect: true,
  options: ["apple", "banana", "cherry"].map((label) => ({
    label,
    description: `${label} option`,
  })),
};
const initial = fixture("standalone-checkbox", "2.1.331");
const review = fixture("standalone-checkbox-review", "2.1.331");
const tabbedHeader = "←  ☐ Repos  ✔ Submit  →";
const bareHeader = " ☐ Repos";
const answers = [{ optionIndexes: [0, 2] }];
const checkboxWrites = [" ", arrowDown, arrowDown, " ", arrowDown, arrowDown];

function requestForFruits() {
  return registry().publish("native", "blocking", [
    {
      prompt: toolQuestion.question,
      header: toolQuestion.header,
      options: toolQuestion.options,
      selection: "multiple",
      textMode: "none",
      supportsSecretInput: false,
    },
  ])!;
}

function checkboxFrames(header: string) {
  const apple = initial.text.replace(tabbedHeader, header).replace("[ ] apple", "[✔] apple");
  const banana = apple.replace("❯ 1.", "  1.").replace("  2.", "❯ 2.");
  const cherry = banana.replace("❯ 2.", "  2.").replace("  3.", "❯ 3.");
  const cherryChecked = cherry.replace("[ ] cherry", "[✔] cherry");
  const other = cherryChecked.replace("❯ 3.", "  3.").replace("  4.", "❯ 4.");
  const submit = other.replace("❯ 4.", "  4.").replace("     Submit", "❯    Submit");
  return [apple, banana, cherry, cherryChecked, other, submit].map(frame);
}

test("C-QUESTION-01 publishes a standalone checkbox only after its matching tabbed panel paints", async () => {
  const h = submissionHarness(initial, [], { questions: [toolQuestion] });
  try {
    h.hook();
    expect(h.questions.list()).toEqual([]);
    await paintQuestionFrame(h.terminal, initial);
    const [request] = h.questions.list();
    expect(request?.questions).toMatchObject([
      { prompt: toolQuestion.question, header: "Repos", selection: "multiple" },
    ]);
    expect(h.observed).toEqual([expect.objectContaining({ phase: "raised", request })]);
    expect(h.writes).toEqual([]);
  } finally {
    h.dispose();
  }
});

test.each([
  { label: "tabbed", header: tabbedHeader, afterCheckbox: [review], extraEnters: ["\r"] },
  { label: "bare", header: bareHeader, afterCheckbox: [], extraEnters: [] },
])("C-QUESTION-03 writes the checkbox and confirmation sequence on the $label layout", async ({
  header,
  afterCheckbox,
  extraEnters,
}) => {
  const { io, writes } = scriptedQuestionIo(frame(initial.text.replace(tabbedHeader, header)), [
    ...checkboxFrames(header),
    ...afterCheckbox,
  ]);
  await answerClaudeQuestions(requestForFruits(), answers, io);
  expect(writes).toEqual([...checkboxWrites, "\r", ...extraEnters]);
});

test("C-QUESTION-03 rechecks a box a person checked after the answer's first, in native order", async () => {
  // Claude lists labels in the order they were checked, so keeping Cherry would report `cherry, apple`.
  const [apple, banana, cherry, cherryChecked, other, submit] = checkboxFrames(tabbedHeader);
  const withCherry = (screen: QuestionFrame) =>
    frame(screen.text.replace("[ ] cherry", "[✔] cherry"));
  const onCherry = initial.text.replace("❯ 1.", "  1.").replace("  3.", "❯ 3.");
  const onBanana = initial.text.replace("❯ 1.", "  1.").replace("  2.", "❯ 2.");
  const { io, writes } = scriptedQuestionIo(withCherry(frame(onCherry)), [
    withCherry(frame(onBanana)),
    withCherry(initial),
    withCherry(apple!),
    withCherry(banana!),
    cherryChecked!,
    cherry!,
    cherryChecked!,
    other!,
    submit!,
    review,
  ]);
  await answerClaudeQuestions(requestForFruits(), answers, io);
  expect(writes).toEqual([
    arrowUp,
    arrowUp,
    " ",
    arrowDown,
    arrowDown,
    " ",
    " ",
    arrowDown,
    arrowDown,
    "\r",
    "\r",
  ]);
});

test("C-QUESTION-03 rejects altered standalone review values before final Enter", async () => {
  const { io, writes } = scriptedQuestionIo(initial, [
    ...checkboxFrames(tabbedHeader),
    frame(review.text.replace("apple, cherry", "banana, cherry")),
  ]);
  await expect(answerClaudeQuestions(requestForFruits(), answers, io)).rejects.toMatchObject({
    code: "question_answer_failed",
  });
  expect(writes).toEqual([...checkboxWrites, "\r"]);
});

test.each([
  [tabbedHeader, bareHeader],
  [bareHeader, tabbedHeader],
])("C-QUESTION-03 refuses a checkbox write when the verified standalone layout changes (%#)", async (before, after) => {
  const beforeFrame = frame(initial.text.replace(tabbedHeader, before));
  const afterFrame = frame(initial.text.replace(tabbedHeader, after));
  const writes: string[] = [];
  await expect(
    answerClaudeQuestions(requestForFruits(), answers, {
      signal: new AbortController().signal,
      frame: () => beforeFrame,
      wait: () => Promise.reject(new Error("A changed layout must not reach a render wait")),
      write: (input, acceptsCurrentFrame) => {
        if (!acceptsCurrentFrame(afterFrame)) return Promise.reject(questionAnswerFailed());
        writes.push(input);
        return Promise.resolve();
      },
    }),
  ).rejects.toMatchObject({ code: "question_answer_failed" });
  expect(writes).toEqual([]);
});

test("C-QUESTION-03 rejects Submit tabs on an otherwise matching standalone radio question", () => {
  const radio = fixture("single-question", "2.1.310");
  const tabbed = frame(radio.text.replace(" ☐ Test pick ", "←  ☐ Test pick  ✔ Submit  →"));
  expect(parseClaudeQuestionScreen(tabbed, [testPick])).toBeUndefined();
});

test("C-QUESTION-03 stops when the Submit tab disappears after a successful checkbox write", async () => {
  const [selected] = checkboxFrames(bareHeader);
  const { io, writes } = scriptedQuestionIo(initial, [selected!]);
  await expect(answerClaudeQuestions(requestForFruits(), answers, io)).rejects.toThrow(
    "Unexpected native wait stage",
  );
  expect(writes).toEqual([" "]);
});

test("C-QUESTION-03 rejects a standalone review without the native Submit tab", () => {
  const bare = frame(review.text.replace("←  ☒ Repos  ✔ Submit  →", bareHeader));
  expect(parseClaudeQuestionScreen(bare, requestForFruits().questions)).toBeUndefined();
});
