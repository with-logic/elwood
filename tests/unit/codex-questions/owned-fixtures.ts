/** Captured editor values and native metadata for owned-answer proofs (PRD §4). */
import { isRecord } from "../../../src/core/predicates.ts";
import type { QuestionFrame } from "../../../src/core/questions/adapter.ts";
import type { QuestionDefinition } from "../../../src/core/questions/types.ts";
import { fixture } from "./helpers.ts";
import { nativeFrame } from "./native-frame.ts";

export type Mode = "queued" | "modal";
const prompts = [
  "ELWOOD_RAW_LITERAL: Enter the literal",
  "ELWOOD_RAW_LONG: Enter the long text",
] as const;
export function expected(mode: Mode): { readonly literal: string; readonly long: string } {
  const value: unknown = JSON.parse(fixture(`editor/${mode}-expected.json`));
  if (
    !(isRecord(value) && typeof value["literal"] === "string" && typeof value["long"] === "string")
  )
    throw new Error("Expected captured literal and long editor strings");
  return { literal: value["literal"], long: value["long"] };
}
type QueuedAnswer = { readonly questionItemId: string; readonly answer: string };
function isQueuedAnswer(value: unknown): value is QueuedAnswer {
  return (
    isRecord(value) &&
    typeof value["questionItemId"] === "string" &&
    typeof value["answer"] === "string"
  );
}
export function queuedAcceptance(): { readonly answers: readonly [QueuedAnswer, QueuedAnswer] } {
  const value: unknown = JSON.parse(fixture("editor/queued-acceptance.json"));
  const answers = isRecord(value) ? value["answers"] : undefined;
  if (
    !(
      Array.isArray(answers) &&
      answers.length === 2 &&
      isQueuedAnswer(answers[0]) &&
      isQueuedAnswer(answers[1])
    )
  )
    throw new Error("Expected exactly two captured queued answers");
  return { answers: [answers[0], answers[1]] };
}
export function modalAcceptance(): {
  readonly callId: string;
  readonly answers: Readonly<Record<string, { readonly answers: readonly string[] }>>;
} {
  const value: unknown = JSON.parse(fixture("editor/modal-acceptance.json"));
  if (!(isRecord(value) && typeof value["callId"] === "string" && isRecord(value["answers"])))
    throw new Error("Expected a captured modal answer map and call ID");
  const answers: Record<string, { readonly answers: readonly string[] }> = {};
  for (const [key, row] of Object.entries(value["answers"])) {
    const strings = isRecord(row) ? row["answers"] : undefined;
    if (
      !(
        Array.isArray(strings) &&
        strings.every((answer): answer is string => typeof answer === "string")
      )
    )
      throw new Error(`Expected captured modal answer strings for ${key}`);
    answers[key] = { answers: strings };
  }
  return { callId: value["callId"], answers };
}
export function definitions(mode: Mode): readonly QuestionDefinition[] {
  return prompts.map((prompt, index) => ({
    prompt,
    options:
      mode === "queued"
        ? []
        : [
            { label: index === 0 ? "Proceed" : "Short", description: "First" },
            { label: index === 0 ? "Wait" : "Long", description: "Second" },
            { label: "None of the above", description: "Optionally, add details in notes (tab)" },
          ],
    selection: mode === "queued" ? "none" : "single",
    textMode: mode === "queued" ? "alternative" : "additional",
    secret: false,
  }));
}
export function metadata(mode: Mode, count = 2) {
  const questions = definitions(mode)
    .slice(0, count)
    .map((question, index) =>
      mode === "queued"
        ? { title: question.prompt }
        : {
            id: index === 0 ? "literal" : "long",
            question: question.prompt,
            options: question.options.slice(0, 2),
          },
    );
  const call_id =
    mode === "queued" ? "call_9f8fad43431b4ac3afae9756c0f9a7f7" : modalAcceptance().callId;
  return {
    type: "function_call",
    name: mode === "queued" ? "request_user_input_async" : "request_user_input",
    call_id,
    arguments: JSON.stringify({ questions }),
  };
}
export function emptyLong(): QuestionFrame {
  const source = nativeFrame("editor/queued-literal-empty.json");
  const lines = source.lines
    .map((line) => line.replace(prompts[0], prompts[1]))
    .filter((line) => line.trim() !== "1 of 2");
  return {
    ...source,
    lines,
    text: lines.join("\n"),
    cursorY: source.cursorY - 1,
    cursorRow: source.cursorRow - 1,
  };
}
export function selector(notes: QuestionFrame): QuestionFrame {
  const lines = notes.lines.map((line) =>
    line.trim() === "› Add notes"
      ? " "
      : line.replace(
          "tab or esc to clear notes | enter to submit answer",
          "tab to add notes | enter to submit answer | ←/→ to navigate questions | esc to interrupt",
        ),
  );
  return { ...notes, lines, text: lines.join("\n"), cursorVisible: false };
}
