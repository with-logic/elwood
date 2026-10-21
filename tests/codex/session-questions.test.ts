/** Public Codex questions across real transcript and terminal boundaries (PRD §7A.5). */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { resumeCodex, startCodex } from "../../src/index.ts";
import { captured, records } from "../unit/codex-questions/helpers.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);
const clear = (text: string) => `\x1b[2J\x1b[H${text.replaceAll("\n", "\r\n")}`;
const nativePanel = (name: string) => {
  const text = captured(name).text;
  return text.slice(text.lastIndexOf("• Queued follow-up inputs")).trimEnd();
};
test("C-QUESTION-01 C-QUESTION-02 answers queued questions while an ordinary writer is already held", async () => {
  installFakes();
  const cwd = tempDir();
  const path = join(cwd, "transcript.jsonl");
  writeFileSync(path, "");
  const session = await startCodex({ cwd, initialSize: { cols: 140, rows: 45 } });
  await becomeReady(session.elwoodSessionId, cwd, { transcript_path: path });
  const native = records("async-records.json");
  const append = (item: unknown) => appendFileSync(path, `${JSON.stringify(item)}\n`);
  for (const item of native.slice(0, 3)) append(item);
  ptys[0]!.emitData(clear(`${nativePanel("async-badge.txt")}\n› Ask Codex to do anything`));
  await expect.poll(() => session.listQuestions()).toHaveLength(2);
  const requests = await session.listQuestions();
  const activity: string[] = [];
  session.on("activity", (event) => activity.push(event.kind));
  let ordinaryDone = false;
  const ordinary = session.sendMessage("ordinary follow-up").then(() => {
    ordinaryDone = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(ptys[0]!.writes).toEqual([]);
  let phase = 0;
  const write = ptys[0]!.write.bind(ptys[0]);
  ptys[0]!.write = (input) => {
    write(input);
    if (input === "\x1b[1;2D") ptys[0]!.emitData(clear(nativePanel("async-editor-first.txt")));
    else if (input === "\x1b[B") ptys[0]!.emitData(clear(nativePanel("async-editor-blue.txt")));
    else if (input === "\x1b[200~ELWOOD_NOTE_74\x1b[201~")
      ptys[0]!.emitData(clear(nativePanel("async-editor-note.txt")));
    else if (input === "\r" && phase < 2) {
      append(native[phase + 3]);
      phase += 1;
      ptys[0]!.emitData(
        clear(phase === 1 ? nativePanel("async-after-first.txt") : "› Ask Codex to do anything"),
      );
    }
  };
  const color = requests[0]!.questions[0]!;
  await session.answerQuestions(requests[0]!.id, [
    { questionId: color.id, optionIds: [color.options[1]!.id] },
  ]);
  expect(await session.listQuestions()).toEqual([requests[1]]);
  expect(ordinaryDone).toBe(false);
  const note = requests[1]!.questions[0]!;
  await session.answerQuestions(requests[1]!.id, [{ questionId: note.id, text: "ELWOOD_NOTE_74" }]);
  await ordinary;
  expect(ptys[0]!.writes).toEqual([
    "\x1b[1;2D",
    "\x1b[B",
    "\r",
    "\x1b[200~ELWOOD_NOTE_74\x1b[201~",
    "\r",
    "\x1b[200~ordinary follow-up\x1b[201~",
    "\r",
  ]);
  expect(activity).not.toContain("assistant_message");
  expect(
    readFileSync(join(cwd, ".elwood", "sessions", session.elwoodSessionId, "session.json"), "utf8"),
  ).not.toContain("ELWOOD_ASYNC");
  await expect(session.answerQuestions(requests[0]!.id, [])).rejects.toMatchObject({
    code: "question_not_found",
  });
  await session.kill();
});
test("C-QUESTION-01 previous transcript questions never reopen in a new live runtime", async () => {
  installFakes();
  const cwd = tempDir();
  const path = join(cwd, "transcript.jsonl");
  writeFileSync(
    path,
    records("async-records.json")
      .map((record) => `${JSON.stringify(record)}\n`)
      .join(""),
  );
  const session = await startCodex({ cwd });
  await becomeReady(session.elwoodSessionId, cwd, { transcript_path: path });
  ptys[0]!.emitData(clear(`${nativePanel("async-badge.txt")}\n› Ask Codex to do anything`));
  await session.terminal.settled();
  expect(await session.listQuestions()).toEqual([]);
  await expect(session.answerQuestions("old-live-request", [])).rejects.toMatchObject({
    code: "question_not_found",
  });
  expect(ptys[0]!.writes).toEqual([]);
  await session.kill();
});
test("C-QUESTION-02 the same durable session ID cannot authorize an old live request after resume", async () => {
  installFakes();
  const cwd = tempDir();
  const path = join(cwd, "transcript.jsonl");
  writeFileSync(path, "");
  const first = await startCodex({ cwd });
  await becomeReady(first.elwoodSessionId, cwd, { transcript_path: path });
  for (const item of records("async-records.json").slice(0, 3))
    appendFileSync(path, `${JSON.stringify(item)}\n`);
  ptys[0]!.emitData(clear(nativePanel("async-badge.txt")));
  await expect.poll(() => first.listQuestions()).toHaveLength(2);
  const previousId = (await first.listQuestions())[0]!.id;
  await first.kill();
  const resumed = await resumeCodex({ cwd, elwoodSessionId: first.elwoodSessionId });
  try {
    expect(resumed.elwoodSessionId).toBe(first.elwoodSessionId);
    await ptys[1]!.dispatchHook(resumed.elwoodSessionId, {
      hook_event_name: "SessionStart",
      session_id: "codex-1",
      cwd,
      source: "resume",
      transcript_path: path,
    });
    ptys[1]!.emitData(clear(nativePanel("async-badge.txt")));
    await resumed.terminal.settled();
    expect(await resumed.listQuestions()).toEqual([]);
    await expect(resumed.answerQuestions(previousId, [])).rejects.toMatchObject({
      code: "question_not_found",
    });
    expect(ptys[1]!.writes).toEqual([]);
  } finally {
    await resumed.kill();
  }
});
