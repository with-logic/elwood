/** Guard Claude trust answers against synchronous delivery and retained replay (C-ATTN-07, C-ATTN-08). */
import { renameSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { composer, selectYes, setupClaudeAnswer } from "./workspace-trust-answer-fixture.ts";

test.each([
  true,
  false,
])("C-ATTN-07 Claude verifies an answer after every synchronous dialog listener (scope changed: %s)", async (scopeChanged) => {
  const { root, session, pty, render, menu, request, settle, beforeProof } =
    await setupClaudeAnswer({ repository: true });
  await render(menu("yes"));
  const opened = await request();
  await settle();
  beforeProof.mockClear();

  const answer = Promise.withResolvers<void>();
  const result = answer.promise.catch((error: unknown) => error);
  const laterListener = Promise.withResolvers<number>();
  session.on("dialog", (event) => {
    if (event.phase === "raised") {
      answer.resolve(session.answerDialog(event.request.id, opened.choices[1]!.id));
    }
  });
  session.on("dialog", (event) => {
    if (event.phase === "raised") {
      if (scopeChanged) renameSync(join(root, ".git"), join(root, "former-git"));
      laterListener.resolve(beforeProof.mock.calls.length);
    }
  });

  expect(await laterListener.promise).toBe(1);
  if (scopeChanged) {
    expect(await result).toMatchObject({ details: { category: "frame" } });
    expect(pty.writes).toEqual([]);
    expect(await session.listDialogs()).toEqual([]);
  } else {
    await expect.poll(() => pty.writes).toEqual([`${selectYes}\r`]);
    await render(composer);
    expect(await result).toBeUndefined();
  }
});

test("C-ATTN-07 a real Claude replay invalidates an answer proof begun before that delivery", async () => {
  const { root, session, pty, render, menu, request, settle, beforeProof } =
    await setupClaudeAnswer({ repository: true });
  await render(menu("yes"));
  const opened = await request();
  await settle();
  const firstRaise = Promise.withResolvers<void>();
  session.on("dialog", ({ phase }) => {
    if (phase === "raised") firstRaise.resolve();
  });
  await firstRaise.promise;

  const entered = Promise.withResolvers<void>();
  const finishProof = Promise.withResolvers<boolean>();
  beforeProof.mockImplementationOnce(() => {
    entered.resolve();
    return finishProof.promise;
  });
  const answer = session
    .answerDialog(opened.id, opened.choices[1]!.id, { timeoutMs: 250 })
    .catch((error: unknown) => error);
  await entered.promise;

  const replay = Promise.withResolvers<void>();
  session.on("dialog", ({ phase }) => {
    if (phase === "raised") {
      renameSync(join(root, ".git"), join(root, "former-git"));
      replay.resolve();
    }
  });
  await replay.promise;
  finishProof.resolve(true);
  await vi.advanceTimersByTimeAsync(250);

  expect(pty.writes).toEqual([]);
  expect(await answer).toMatchObject({ details: { category: "frame" } });
  expect(await session.listDialogs()).toEqual([]);
});
