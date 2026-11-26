/** Native async choice panels hide the cursor while work redraws (PRD §4, §5.10). */
import { expect, test } from "vitest";
import { questionView } from "../../../src/codex/questions/frame.ts";
import { captured } from "./helpers.ts";
import { nativeFrame } from "./native-frame.ts";

const native = nativeFrame("remaining-color-native.json");
// Codex 0.172 redraws only the working-row cells that changed and leaves its hidden cursor after
// the last one: the pulsing glyph (as captured), an elapsed-time digit, or the row's end.
const glyph = nativeFrame("remaining-color-glyph-cursor.json", "0.172.0");
const workingRow = glyph.lines[glyph.cursorRow]!;
test("a hidden native cursor can remain on the working row above choices", () => {
  expect(questionView(native)).toMatchObject({ kind: "queued", count: 1, index: 0, selected: 0 });
});
test.each([
  ["after the pulsing glyph", glyph.cursorX],
  ["after an elapsed-time digit", workingRow.indexOf("s •")],
  ["at the row's end", workingRow.length],
])("a hidden Codex 0.172 cursor on the working row %s keeps the choices", (_, cursorX) => {
  expect(cursorX).toBeGreaterThan(0);
  expect(questionView({ ...glyph, cursorX })).toMatchObject({
    kind: "queued",
    count: 1,
    index: 0,
    selected: 0,
  });
});
test("working-row cursor evidence still rejects unrelated or visible cursors", () => {
  expect(questionView({ ...native, cursorVisible: true })).toBeUndefined();
  expect(questionView({ ...native, cursorX: 0 })).toBeUndefined();
  expect(questionView({ ...glyph, cursorX: workingRow.length + 1 })).toBeUndefined();
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
