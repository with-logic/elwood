/** Exercise Claude workspace trust ownership without suppressing discovery (C-ATTN-07). */
import { expect, test, vi } from "vitest";
import { selectYes, setupClaudeAnswer } from "./workspace-trust-answer-fixture.ts";

test("C-ATTN-07 raw input during an unsettled repaint only claims the known Claude request", async () => {
  const { session, pty, render, menu, request, settle } = await setupClaudeAnswer();
  // Input before any known gate must not claim a future request.
  await session.sendKeys("\x1b[A");
  await render(menu("no"));
  const opened = await request();

  pty.emitData(`\x1b[2J\x1b[H${menu("yes")}`);
  await session.sendKeys("\x1b[B");
  await vi.advanceTimersByTimeAsync(10);
  expect(await request()).toEqual(opened);

  const refusal = expect(
    session.answerDialog(opened.id, opened.choices[1]!.id),
  ).rejects.toMatchObject({ details: { category: "frame" } });
  await settle();
  await refusal;
  expect(pty.writes).toEqual(["\x1b[A", "\x1b[B"]);
});

test("C-ATTN-07 raw input on an observed Claude menu while listing waits for proof", async () => {
  const { session, pty, render, menu, request, settle, beforeProof } = await setupClaudeAnswer();
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  beforeProof.mockImplementationOnce(async () => {
    entered.resolve();
    await resume.promise;
    return undefined;
  });
  await render(menu("yes"));
  const listing = session.listDialogs();
  await entered.promise;
  try {
    await session.sendKeys("\x1b[B");
  } finally {
    resume.resolve();
  }
  await listing;
  const opened = await request();
  const refusal = expect(
    session.answerDialog(opened.id, opened.choices[1]!.id),
  ).rejects.toMatchObject({ details: { category: "frame" } });
  await settle();
  await refusal;
  expect(await request()).toEqual(opened);
  expect(pty.writes).toEqual(["\x1b[B"]);
});

test("C-ATTN-07 Claude reserves structured writing to manual trust sessions", async () => {
  const { session, pty, render, menu, request, settle, beforeProof } = await setupClaudeAnswer({
    autotrust: true,
  });
  await render(menu("yes"));
  await vi.advanceTimersByTimeAsync(5_020);
  const opened = await request();
  await settle();
  const writes = [...pty.writes];
  beforeProof.mockResolvedValueOnce(true);
  const refused = session
    .answerDialog(opened.id, opened.choices[1]!.id, { timeoutMs: 250 })
    .catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(250);
  expect(pty.writes).toEqual(writes);
  expect(await refused).toMatchObject({ code: "dialog_not_found" });
});

test("C-ATTN-07 raw input on a settled off-menu frame cannot claim the next Claude layout", async () => {
  const { session, pty, render, menu, request, settle } = await setupClaudeAnswer();
  await render("Claude Code is starting…");
  await session.sendKeys("\x1b[A");
  await render(menu("yes"));
  const opened = await request();
  const answer = session.answerDialog(opened.id, opened.choices[1]!.id);
  void answer.catch(() => undefined);
  await settle();
  await vi.waitFor(() => expect(pty.writes).toEqual(["\x1b[A", `${selectYes}\r`]));
  pty.emitExit({ exitCode: 0 });
  await expect(answer).rejects.toMatchObject({ details: { category: "terminal_exit" } });
});
