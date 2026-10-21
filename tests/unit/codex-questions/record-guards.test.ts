/** Preserve native capabilities and bounded reply parsing (PRD §4). */
import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";
import { parseQuestions } from "../../../src/codex/questions/definitions.ts";
import { answeredQuestionIds } from "../../../src/codex/questions/records.ts";

const open = "<send_user_message_question_reply>";
const close = "</send_user_message_question_reply>";
const body = JSON.stringify([{ questionItemId: "question", answer: "Blue" }]);
const message = (text: string) => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }],
});

test("C-QUESTION-01 preserves choice and free-text capabilities", () => {
  const queued = parseQuestions([{ title: "Q", options: ["A"] }, { title: "Text" }], true)!;
  expect(queued.map(({ definition }) => [definition.selection, definition.textMode])).toEqual([
    ["single", "alternative"],
    ["none", "alternative"],
  ]);
  const modal = parseQuestions([{ id: "q", question: "Q", options: [{ label: "A" }] }], false)!;
  expect(modal[0]?.definition).toMatchObject({ selection: "single", textMode: "additional" });
});

test("C-QUESTION-01 rejects duplicate modal identities before acknowledgement is ambiguous", () => {
  const question = { id: "same", question: "First", options: [{ label: "A" }] };
  expect(parseQuestions([question, { ...question, question: "Second" }], false)).toBeUndefined();
  expect(parseQuestions([question, { ...question, id: "second" }], false)).toHaveLength(2);
});

test.each([
  "",
  "\n",
  "\u00a0\ufeff\v\f",
])("C-QUESTION-01 preserves native reply body whitespace %j", (space) => {
  expect(answeredQuestionIds(message(`${open}${space}${body}${space}${close}`))).toEqual([
    "question",
  ]);
});
test.each([
  "\n",
  "\r",
  "\r\n",
  "\u2028",
  "\u2029",
  " ",
  "x",
])("C-QUESTION-01 ignores text after the exact native reply wrapper %j", (suffix) => {
  expect(answeredQuestionIds(message(`${open}${body}${close}${suffix}`))).toEqual([]);
});

test("C-QUESTION-01 incomplete whitespace-heavy replies finish within a process deadline", () => {
  const moduleUrl = new URL("../../../src/codex/questions/records.ts", import.meta.url).href;
  const script = `
    import { answeredQuestionIds } from ${JSON.stringify(moduleUrl)};
    const text = ${JSON.stringify(open)} + " ".repeat(10_000) + "x";
    console.log(JSON.stringify(answeredQuestionIds({
      type: "message", role: "user", content: [{ type: "input_text", text }]
    })));
  `;
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", script],
    { encoding: "utf8", timeout: 8_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("[]");
}, 20_000);
