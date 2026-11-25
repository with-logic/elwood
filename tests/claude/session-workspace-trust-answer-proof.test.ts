/** Assert Claude structured writes remain scoped across asynchronous Git proof (C-ATTN-07). */
import { renameSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { selectYes, setupClaudeAnswer } from "./workspace-trust-answer-fixture.ts";

test.each([
  "native repaint",
  "raw input",
  "abort",
  "deadline",
  "Git change",
] as const)("C-ATTN-07 %s during Claude's first proof cannot authorize a physical key", async (mutation) => {
  const { root, session, pty, render, menu, request, settle, beforeProof } =
    await setupClaudeAnswer({
      repository: true,
    });
  await render(menu("yes"));
  const opened = await request();
  await settle();

  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  beforeProof.mockImplementationOnce(async () => {
    entered.resolve();
    await resume.promise;
    return mutation === "Git change" ? undefined : true;
  });
  const abort = new AbortController();
  const category = {
    "native repaint": "frame",
    "raw input": "aborted",
    abort: "aborted",
    deadline: "frame",
    "Git change": "frame",
  }[mutation];
  const refusal = session
    .answerDialog(opened.id, opened.choices[1]!.id, {
      signal: abort.signal,
      timeoutMs: 250,
    })
    .catch((error: unknown) => error);
  await entered.promise;
  try {
    switch (mutation) {
      case "native repaint":
        await render(menu("yes"));
        break;
      case "raw input":
        await session.sendKeys("\x1b[B");
        break;
      case "abort":
        abort.abort();
        break;
      case "deadline":
        await vi.advanceTimersByTimeAsync(250);
        break;
      case "Git change":
        renameSync(join(root, ".git"), join(root, "previous-git"));
        break;
    }
  } finally {
    resume.resolve();
  }
  const writes = mutation === "raw input" ? ["\x1b[B"] : [];
  if (mutation !== "Git change") {
    await vi.advanceTimersByTimeAsync(mutation === "native repaint" ? 250 : 0);
    expect(pty.writes).toEqual(writes);
  }
  expect(await refusal).toMatchObject({ details: { category } });
  if (mutation !== "Git change") expect(await request()).toEqual(opened);
  expect(pty.writes).toEqual(writes);
});

test("C-ATTN-07 Claude revalidates Git scope after navigation and before Enter", async () => {
  const { root, session, pty, render, menu, request, settle, beforeProof } =
    await setupClaudeAnswer({
      repository: true,
    });
  await render(menu("no"));
  const opened = await request();
  await settle();
  const refusal = session
    .answerDialog(opened.id, opened.choices[1]!.id)
    .catch((error: unknown) => error);
  await vi.waitFor(() => expect(pty.writes).toEqual([selectYes]));

  // Observe the key proof on the repaint independently of list requests.
  let checkedAfterNavigation = false;
  beforeProof.mockImplementationOnce(() => {
    renameSync(join(root, ".git"), join(root, "previous-git"));
    checkedAfterNavigation = true;
    return Promise.resolve(undefined);
  });
  await render(menu("yes"));
  await vi.waitFor(() => {
    expect(pty.writes).toEqual([selectYes]);
    expect(checkedAfterNavigation).toBe(true);
  });
  expect(await refusal).toMatchObject({ details: { category: "frame" } });
  expect(pty.writes).toEqual([selectYes]);
  expect(await session.listDialogs()).toEqual([]);
});

test("C-ATTN-07 raw ownership of one Claude layout leaves its replacement answerable", async () => {
  const { session, pty, render, menu, request, settle } = await setupClaudeAnswer();
  await render(menu("yes"));
  const original = await request();
  await session.sendKeys("\x1b[B");
  await render(
    menu("yes").replace(
      "   No, exit\r\n ❯ Yes, I trust this folder",
      " ❯ Yes, I trust this folder\r\n   No, exit",
    ),
  );
  const replacement = await request();
  expect(replacement.id).not.toBe(original.id);
  const answer = session.answerDialog(replacement.id, replacement.choices[0]!.id);
  void answer.catch(() => undefined);
  await settle();
  await vi.waitFor(() => expect(pty.writes).toEqual(["\x1b[B", "\x1b[H\r"]));
  pty.emitExit({ exitCode: 0 });
  await expect(answer).rejects.toMatchObject({ details: { category: "terminal_exit" } });
});

test("C-ATTN-07 Claude checks for newly queued output before starting a key's Git proof", async () => {
  const { session, pty, render, menu, request, settle, beforeProof } = await setupClaudeAnswer();
  await render(menu("yes"));
  const opened = await request();
  await settle();
  beforeProof.mockClear();

  const answer = session.answerDialog(opened.id, opened.choices[1]!.id);
  pty.emitData("\r\n");
  await expect(answer).rejects.toMatchObject({ details: { category: "frame" } });
  expect(beforeProof).not.toHaveBeenCalled();
  expect(pty.writes).toEqual([]);
});
