/** Exercise invalidation and write ownership for Claude workspace answers (C-ATTN-07). */
import { renameSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { selectYes, setupClaudeAnswer } from "./workspace-trust-answer-fixture.ts";

test("C-ATTN-07 grace reserves the answer and respects cancellation and timeout", async () => {
  const { session, pty, render, menu, request } = await setupClaudeAnswer();
  await render(menu("yes"));
  const opened = await request();
  const choice = opened.choices[1]!.id;
  const abort = new AbortController();
  const pending = expect(
    session.answerDialog(opened.id, choice, { signal: abort.signal }),
  ).rejects.toMatchObject({ code: "dialog_answer_failed", details: { category: "aborted" } });
  await expect(session.answerDialog(opened.id, choice)).rejects.toMatchObject({
    details: { category: "busy" },
  });
  abort.abort();
  await pending;
  const expired = expect(
    session.answerDialog(opened.id, choice, { timeoutMs: 75 }),
  ).rejects.toMatchObject({ details: { category: "frame" } });
  await vi.advanceTimersByTimeAsync(75);
  await expired;
  expect(pty.writes).toEqual([]);
  expect(await session.listDialogs()).toEqual([opened]);
});

test.each([
  false,
  true,
])("C-ATTN-07 scope loss revokes the request without a new key (confirmed=%s)", async (confirmed) => {
  const { root, session, pty, render, menu, request, settle } = await setupClaudeAnswer({
    repository: true,
  });
  await render(menu("yes"));
  const opened = await request();
  const answer = () => session.answerDialog(opened.id, opened.choices[1]!.id);
  const failed = expect(answer()).rejects.toMatchObject({ details: { category: "frame" } });
  if (confirmed) {
    await settle();
    await vi.waitFor(() => expect(pty.writes).toEqual([`${selectYes}\r`]));
  }
  renameSync(join(root, ".git"), join(root, "previous-git"));
  if (confirmed) {
    await render(menu("yes"));
    expect(await session.listDialogs()).toEqual([]);
  } else await settle();
  await failed;
  expect(await session.listDialogs()).toEqual([]);
  await expect(answer()).rejects.toMatchObject({ code: "dialog_not_found" });
  expect(pty.writes).toEqual(confirmed ? [`${selectYes}\r`] : []);
});

test.each([
  "unrendered native output",
  "caller clear during options validation",
])("C-ATTN-07 %s invalidates the first physical write", async (change) => {
  const { session, pty, render, menu, request, settle } = await setupClaudeAnswer();
  await render(menu("yes"));
  const opened = await request();
  await settle();
  const options =
    change === "caller clear during options validation"
      ? {
          get timeoutMs() {
            session.terminal.xterm.clear();
            return 500;
          },
        }
      : undefined;
  if (!options) pty.emitData("\r\n");
  await expect(
    session.answerDialog(opened.id, opened.choices[1]!.id, options),
  ).rejects.toMatchObject({ details: { category: "frame" } });
  expect(pty.writes).toEqual([]);
});

test("C-ATTN-07 refuses invalid choices, malformed deadlines, and pre-aborted answers", async () => {
  const { session, pty, render, menu, request } = await setupClaudeAnswer();
  await render(menu("yes"));
  const opened = await request();
  const choice = opened.choices[1]!.id;
  for (const args of [
    [opened.id, "invalid"],
    [opened.id, choice, null],
    [opened.id, choice, { timeoutMs: 0 }],
  ])
    await expect(Reflect.apply(session.answerDialog, session, args)).rejects.toMatchObject({
      code: "invalid_dialog_answer",
    });
  await expect(
    session.answerDialog(opened.id, choice, { signal: AbortSignal.abort() }),
  ).rejects.toMatchObject({ details: { category: "aborted" } });
  expect(pty.writes).toEqual([]);
});

test.each([
  "sendKeys",
  "terminal.sendInput",
  "xterm.input",
] as const)("C-ATTN-07 raw %s reserves this native menu while retaining read-only discovery", async (method) => {
  const { session, pty, render, menu, request } = await setupClaudeAnswer();
  await render(menu("no"));
  const opened = await request();
  const failed = expect(
    session.answerDialog(opened.id, opened.choices[1]!.id),
  ).rejects.toMatchObject({
    details: { category: "aborted" },
  });
  if (method === "sendKeys") await session.sendKeys("\x1b[B");
  else if (method === "terminal.sendInput") await session.terminal.sendInput("\x1b[B");
  else session.terminal.xterm.input("\x1b[B");
  await failed;
  await render(menu("yes"));
  expect(await request()).toEqual(opened);
  const refusal = expect(
    session.answerDialog(opened.id, opened.choices[1]!.id),
  ).rejects.toMatchObject({ details: { category: "frame" } });
  await vi.advanceTimersByTimeAsync(1_500);
  await refusal;
  expect(pty.writes).toEqual(["\x1b[B"]);
});

test("C-ATTN-07 a resize invalidates a pending answer and retires its ID", async () => {
  const { session, pty, render, menu, request } = await setupClaudeAnswer();
  await render(menu("yes"));
  const opened = await request();
  const answer = () => session.answerDialog(opened.id, opened.choices[1]!.id);
  const failed = expect(answer()).rejects.toMatchObject({ details: { category: "frame" } });
  const { xterm } = session.terminal;
  xterm.resize(xterm.cols + 2, xterm.rows);
  const immediatelyUnavailable = answer();
  await expect(immediatelyUnavailable).rejects.toMatchObject({ code: "dialog_not_found" });
  await failed;
  await expect(answer()).rejects.toMatchObject({ code: "dialog_not_found" });
  expect(pty.writes).toEqual([]);
});

test("C-ATTN-07 a rejected physical confirmation does not transfer authority back", async () => {
  const { session, pty, render, menu, request, settle } = await setupClaudeAnswer();
  await render(menu("yes"));
  const opened = await request();
  pty.failOnWrite = `${selectYes}\r`;
  const failed = expect(
    session.answerDialog(opened.id, opened.choices[1]!.id),
  ).rejects.toMatchObject({ details: { category: "terminal_write" } });
  await settle();
  await failed;
  await render(menu("yes"));
  expect(await session.listDialogs()).toEqual([opened]);
  await expect(session.answerDialog(opened.id, opened.choices[1]!.id)).rejects.toMatchObject({
    details: { category: "frame" },
  });
});

test.each([
  "1",
  "8",
])("C-ATTN-07 a numbered Claude choice requires the verified numbering (%s)", async (number) => {
  const { session, pty, render, menu, request, settle } = await setupClaudeAnswer();
  await render(
    menu("no")
      .replace("❯ No, exit", `❯ ${number}. No, exit`)
      .replace("   Yes, I trust this folder", "   2. Yes, I trust this folder"),
  );
  if (number === "8") {
    expect(await session.listDialogs()).toEqual([]);
    expect(pty.writes).toEqual([]);
    return;
  }
  const opened = await request();
  const done = session.answerDialog(opened.id, opened.choices[0]!.id);
  void done.catch(() => undefined);
  await settle();
  await vi.waitFor(() => expect(pty.writes).toEqual(["1\r"]));
  pty.emitExit({ exitCode: 1 });
  await done;
});

test("C-ATTN-07 an unexpected native exit cannot prove affirmative trust", async () => {
  const { session, pty, render, menu, request, settle } = await setupClaudeAnswer();
  await render(menu("yes"));
  const opened = await request();
  const failed = expect(
    session.answerDialog(opened.id, opened.choices[1]!.id),
  ).rejects.toMatchObject({ details: { category: "terminal_exit" } });
  await settle();
  await vi.waitFor(() => expect(pty.writes).toEqual([`${selectYes}\r`]));
  pty.emitExit({ exitCode: 0 });
  await failed;
});
