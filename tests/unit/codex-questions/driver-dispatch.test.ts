/** Submission ownership begins only at guarded native dispatch (PRD §4). */
import { afterEach, expect, test, vi } from "vitest";
import { answerBlocking, answerQueued } from "../../../src/codex/questions/driver.ts";
import type { QuestionIo } from "../../../src/core/questions/adapter.ts";
import { paintQuestionFrame } from "../questions/controller-helpers.ts";
import { disposeInputHarnesses, inputHarness } from "../questions/input-helpers.ts";
import { notesFrame } from "./editor-fixtures.ts";
import { captured, definitions, frame, scriptedIo } from "./helpers.ts";

const queued = definitions("async-records.json");
const modal = definitions("blocking-records.json");
afterEach(async () => {
  await disposeInputHarnesses();
  vi.restoreAllMocks();
});

test.each([
  "queued",
  "blocking",
])("%s ownership revoked after the final predicate prevents submission and real Enter", async (kind) => {
  let retire = false;
  const h = inputHarness((): void => {
    if (retire) h.requests.close(h.request.id, "unavailable");
  });
  // Leave viewport room for the two rows added by the notes editor.
  const initial =
    kind === "queued"
      ? captured("async-editor-first.txt")
      : frame(
          captured("blocking-modal-first.txt")
            .text.trimEnd()
            .replace("Question 1/2", "Question 1/1"),
        );
  await paintQuestionFrame(h.terminal, initial);
  const originalSend = h.input.automated.sendInput.bind(h.input.automated);
  const send = vi.spyOn(h.input.automated, "sendInput");
  if (kind === "blocking")
    send.mockImplementationOnce(async (input) => {
      await originalSend(input);
      const notes = notesFrame(initial);
      await paintQuestionFrame(h.terminal, notes);
      const cursor = `\x1b[${notes.cursorRow + 1};${notes.cursorX + 1}H`;
      const cell = notes.lines[notes.cursorRow]![notes.cursorX]!;
      await h.terminal.writeOutput(`${cursor}\x1b[2m${cell}\x1b[22m${cursor}`);
    });
  let finalPredicatesMatched = 0;
  const io: QuestionIo = {
    ...h.io,
    write: (input, matches, onDispatch) =>
      h.io.write(
        input,
        (current) => {
          const accepted = matches(current);
          if (input === "\r" && accepted) {
            finalPredicatesMatched++;
            retire = true;
          }
          return accepted;
        },
        onDispatch,
      ),
  };
  const submitting = vi.fn();
  const pending =
    kind === "queued"
      ? answerQueued(queued, { optionIndexes: [0] }, 0, io, submitting)
      : answerBlocking([modal[0]!], [{ optionIndexes: [0] }], io, submitting);
  await expect(h.track(pending)).rejects.toMatchObject({ code: "question_answer_failed" });
  expect(finalPredicatesMatched).toBe(1);
  expect(submitting).not.toHaveBeenCalled();
  expect(h.writes).toEqual(kind === "queued" ? [] : ["\t"]);
  expect(send.mock.calls.some(([input]) => input === "\r")).toBe(false);
});

test("a queued answer announces once at real dispatch after the final live guards", async () => {
  const h = inputHarness();
  await paintQuestionFrame(h.terminal, captured("async-editor-first.txt"));
  const submitting = vi.fn(() => {
    expect(h.started).toHaveBeenCalledOnce();
    expect(h.writes).toEqual([]);
  });
  await h.track(answerQueued(queued, { optionIndexes: [0] }, 0, h.io, submitting));
  expect(submitting).toHaveBeenCalledOnce();
  expect(h.writes).toEqual(["\r"]);
  expect(h.settled).toHaveBeenCalledOnce();
});

test("grouped blocking answers announce only dispatch of the last Enter", async () => {
  const first = captured("blocking-modal-first.txt");
  const second = captured("blocking-modal-second.txt");
  const scripted = scriptedIo(first, [
    { input: "\t", next: notesFrame(first) },
    { input: "\r", next: second },
    { input: "\t", next: notesFrame(second) },
    { input: "\r" },
  ]);
  const announcedAfter: string[][] = [];
  await answerBlocking(modal, [{ optionIndexes: [0] }, { optionIndexes: [0] }], scripted.io, () =>
    announcedAfter.push([...scripted.writes]),
  );
  expect(scripted.writes).toEqual(["\t", "\r", "\t", "\r"]);
  expect(announcedAfter).toEqual([["\t", "\r", "\t"]]);
});
