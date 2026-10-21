/** Physical-paste receipts are revoked by takeover, failure and editor replacement (PRD §4). */
import { expect, test } from "vitest";
import { answerQueued } from "../../../src/codex/questions/driver.ts";
import { questionAnswerFailed } from "../../../src/core/questions/errors.ts";
import { scriptedIo } from "./helpers.ts";
import { nativeFrame } from "./native-frame.ts";
import { singleEmpty, typedChrome } from "./owned-chrome-fixtures.ts";
import { definitions } from "./owned-fixtures.ts";

const initial = nativeFrame("editor/queued-literal-empty.json");
const typed = nativeFrame("editor/queued-literal-typed.json");
const answer = { optionIndexes: [], text: "Type your answer" };
const paste = "\x1b[200~Type your answer\x1b[201~";
test.each([
  "paste fails",
  "aborted after paste",
  "aborted after progress",
  "resized",
  "foreign progress",
])("%s cannot authorize Enter from an owned paste", async (race) => {
  const scripted = scriptedIo(initial, [{ input: paste, next: typed }]);
  const io = {
    ...scripted.io,
    write: async (input: string, guard: Parameters<typeof scripted.io.write>[1]) => {
      if (race === "paste fails") throw questionAnswerFailed();
      if (input === "\r") {
        const current = race === "resized" ? { ...typed, cols: 60 } : typed;
        expect(guard(current)).toBe(false);
        throw questionAnswerFailed();
      }
      await scripted.io.write(input, guard);
      if (race === "aborted after paste") scripted.controller.abort();
    },
    wait: async (guard: Parameters<typeof scripted.io.wait>[0]) => {
      if (race === "foreign progress") {
        expect(
          guard({
            ...typed,
            lines: typed.lines.map((line) =>
              line.replace("ELWOOD_RAW_LITERAL: Enter the literal", "Foreign"),
            ),
          }),
        ).toBe(false);
        throw questionAnswerFailed();
      }
      const frame = await scripted.io.wait(guard);
      if (race === "aborted after progress") scripted.controller.abort();
      return frame;
    },
  };
  await expect(answerQueued(definitions("queued"), answer, 0, io, () => {})).rejects.toMatchObject({
    code: "question_answer_failed",
  });
  expect(scripted.writes).not.toContain("\r");
});
test("an owned large-paste token stages text without a length cap", async () => {
  const text = "x".repeat(4096);
  const token = "[Pasted Content 4096 chars]";
  const frame = {
    ...typed,
    lines: typed.lines.map((line) => (line === "  Type your answer" ? `  ${token}` : line)),
    cursorX: token.length + 2,
    cursorLineBefore: `  ${token}`,
  };
  const scripted = scriptedIo(initial, [
    { input: `\x1b[200~${text}\x1b[201~`, next: frame },
    { input: "\r" },
  ]);
  await answerQueued(definitions("queued"), { optionIndexes: [], text }, 0, scripted.io, () => {});
  expect(scripted.writes).toEqual([`\x1b[200~${text}\x1b[201~`, "\r"]);
});
test("an existing Other suggestion preserves the distinct native write-in row", async () => {
  const source = nativeFrame("editor/queued-literal-empty.json");
  const lines = source.lines
    .map((line) =>
      line === "  Type your answer" ? "  › 1. Other\n    2. Other (write an answer)" : line,
    )
    .join("\n")
    .split("\n");
  const question = {
    ...definitions("queued")[0]!,
    options: [{ label: "Other" }],
    selection: "single" as const,
  };
  const frame = { ...source, lines, text: lines.join("\n"), cursorVisible: false };
  const scripted = scriptedIo(frame, [{ input: "\r" }]);
  await answerQueued(
    [question, definitions("queued")[1]!],
    { optionIndexes: [0] },
    0,
    scripted.io,
    () => {},
  );
  expect(scripted.writes).toEqual(["\r"]);
});

test("changing a non-cursor answer row after receipt withholds Enter", async () => {
  const text = "Earlier answer row\nLater cursor row";
  const typedLong = typedChrome("queued", text);
  const editorRow = typedLong.lines.findIndex((line) => line.includes("Earlier answer row"));
  expect(editorRow).toBeGreaterThanOrEqual(0);
  expect(editorRow).toBeLessThan(typedLong.cursorRow);
  const lines = typedLong.lines.map((line, index) =>
    index === editorRow ? line.replace("Earlier", "Changed") : line,
  );
  const changed = { ...typedLong, lines, text: lines.join("\n") };
  const paste = `\x1b[200~${text}\x1b[201~`;
  const scripted = scriptedIo(singleEmpty("queued"), [{ input: paste, next: typedLong }]);
  const io = {
    ...scripted.io,
    write: async (input: string, guard: Parameters<typeof scripted.io.write>[1]) => {
      if (input !== "\r") return await scripted.io.write(input, guard);
      expect(guard(changed)).toBe(false);
      throw questionAnswerFailed();
    },
  };
  await expect(
    answerQueued([definitions("queued")[0]!], { optionIndexes: [], text }, 0, io, () => {}),
  ).rejects.toMatchObject({ code: "question_answer_failed" });
  expect(scripted.writes).toEqual([paste]);
});
