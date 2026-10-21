/** Editor receipts retain current ownership without claiming full logical equality (PRD §4). */
import { expect, test } from "vitest";
import { questionView } from "../../../src/codex/questions/frame.ts";
import { ownedEditorReceipt } from "../../../src/codex/questions/owned-editor.ts";
import { nativeFrame } from "./native-frame.ts";
import { definitions } from "./owned-fixtures.ts";

test("owned receipt rejects missing, placeholder and out-of-editor provenance", () => {
  const frame = nativeFrame("editor/queued-literal-typed.json");
  const view = questionView(frame)!;
  const question = definitions("queued")[0]!;
  const start = view.cursor.row;
  expect(ownedEditorReceipt(frame, view, question)).toBeTypeOf("string");
  for (const cursor of [
    { ...view.cursor, visible: false },
    { ...view.cursor, dimmed: true },
    { ...view.cursor, before: undefined },
    { ...view.cursor, row: start - 1 },
    { ...view.cursor, row: view.rawBody.length },
    { ...view.cursor, before: "  " },
  ])
    expect(ownedEditorReceipt(frame, { ...view, cursor }, question)).toBeUndefined();
  expect(ownedEditorReceipt(frame, view, { ...question, prompt: "Other prompt" })).toBeUndefined();
  expect(
    ownedEditorReceipt(
      frame,
      {
        ...view,
        rawBody: view.rawBody.map((line, index) => (index === start ? line.trimStart() : line)),
      },
      question,
    ),
  ).toBeUndefined();
  const changed = { ...frame, text: frame.text.replace("Working (5s", "Working (9s") };
  expect(ownedEditorReceipt(changed, view, question)).toBe(
    ownedEditorReceipt(frame, view, question),
  );
  expect(ownedEditorReceipt({ ...frame, cols: 60 }, view, question)).not.toBe(
    ownedEditorReceipt(frame, view, question),
  );
});
