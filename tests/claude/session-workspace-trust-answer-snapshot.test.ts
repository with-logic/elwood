/** Contain unreadable native evidence after a structured Claude confirmation (C-ATTN-07). */
import { expect, test, vi } from "vitest";
import { selectYes, setupClaudeAnswer } from "./workspace-trust-answer-fixture.ts";

test("C-ATTN-07 unreadable native evidence after Enter rejects the Claude answer", async () => {
  const { session, pty, render, menu, request, settle } = await setupClaudeAnswer();
  await render(menu("yes"));
  const opened = await request();
  const xterm = session.terminal.xterm;
  const listener = xterm.onData((text) => {
    if (text.endsWith("\r")) xterm.options.allowProposedApi = false;
  });
  try {
    const answer = session.answerDialog(opened.id, opened.choices[1]!.id);
    const result = answer.catch((error: unknown) => error);
    await settle();
    await vi.waitFor(() => expect(pty.writes).toEqual([`${selectYes}\r`]));
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await result).toMatchObject({ details: { category: "frame" } });
  } finally {
    xterm.options.allowProposedApi = true;
    listener.dispose();
  }
});
