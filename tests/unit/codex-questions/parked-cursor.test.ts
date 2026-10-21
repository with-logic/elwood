/** Native async choice panels hide the cursor while work redraws (PRD §7A.5). */
import { expect, test } from "vitest";
import { questionView } from "../../../src/codex/questions/frame.ts";
import type { QuestionFrame } from "../../../src/core/questions/adapter.ts";
import { captured, fixture } from "./helpers.ts";

const native = JSON.parse(fixture("remaining-color-native.json")) as QuestionFrame;
test("C-QUESTION-02 a hidden native cursor can remain on the working row above choices", () => {
  expect(questionView(native)).toMatchObject({ kind: "queued", count: 1, index: 0, selected: 0 });
});
test("C-QUESTION-02 working-row cursor evidence still rejects unrelated or visible cursors", () => {
  expect(questionView({ ...native, cursorVisible: true })).toBeUndefined();
  expect(questionView({ ...native, cursorX: 0 })).toBeUndefined();
  expect(questionView({ ...captured("blocking-modal-first.txt"), cursorRow: 0 })).toBeUndefined();
  const changed = (text: string) => {
    const lines = [...native.lines];
    lines[native.cursorRow] = text;
    return { ...native, lines, text: lines.join("\n"), cursorX: text.length };
  };
  expect(questionView(changed("Working"))).toBeUndefined();
  const unrelated = [...native.lines];
  unrelated[native.cursorRow + 1] = "unrelated dialog";
  expect(questionView({ ...native, lines: unrelated, text: unrelated.join("\n") })).toBeUndefined();
});
