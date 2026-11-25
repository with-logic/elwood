/** Reproduce Claude writer ownership and work-admission regressions (C-ATTN-07). */
import { expect, test, vi } from "vitest";
import * as menuMatcher from "../../src/claude/workspace-trust/menu.ts";
import { composer, setupClaudeAnswer } from "./workspace-trust-answer-fixture.ts";

test.each([
  "queued repaint before first list",
  "queued completion after partial header",
  "settled disclosure without question",
] as const)("C-ATTN-07 caller input retains the Claude gate through %s", async (handoff) => {
  const { session, pty, render, menu, request, settle, beforeProof } = await setupClaudeAnswer();
  const full = menu("yes");
  const partial = full.split("   No, exit")[0]!;
  const disclosure = full.split(" Quick safety check")[0]!;
  const initial = {
    "queued repaint before first list": full,
    "queued completion after partial header": partial,
    "settled disclosure without question": disclosure,
  }[handoff];
  await render(initial);
  if (handoff.startsWith("queued")) pty.emitData(`\x1b[2J\x1b[H${full}`);
  await session.sendKeys("\x1b[B");
  await render(full);
  const opened = await request();
  await settle();

  beforeProof.mockResolvedValueOnce(true);
  const refused = session
    .answerDialog(opened.id, opened.choices[1]!.id, { timeoutMs: 250 })
    .catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(250);
  expect(pty.writes).toEqual(["\x1b[B"]);
  expect(await refused).toMatchObject({ details: { category: "frame" } });
});

test("C-ATTN-07 abandoned Claude answer lookups share the unfinished polling limit", async () => {
  const { session, render, menu, request, settle, beforeProof } = await setupClaudeAnswer();
  await render(menu("yes"));
  const opened = await request();
  await settle();

  const release = Promise.withResolvers<boolean>();
  const held = vi.fn(() => release.promise);
  beforeProof.mockImplementation(held);
  const start = (signal?: AbortSignal) =>
    session
      .answerDialog(opened.id, opened.choices[1]!.id, signal ? { signal } : undefined)
      .catch((error: unknown) => error);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const stop = new AbortController();
      const abandoned = start(stop.signal);
      await vi.advanceTimersByTimeAsync(0);
      expect(held).toHaveBeenCalledTimes(attempt + 1);
      stop.abort();
      expect(await abandoned).toMatchObject({ details: { category: "aborted" } });
    }
    const refused = start(AbortSignal.timeout(250));
    await vi.advanceTimersByTimeAsync(0);
    expect(held).toHaveBeenCalledTimes(2);
    expect(await refused).toMatchObject({ details: { category: "frame" } });
    expect(await session.listDialogs()).toEqual([]);
  } finally {
    release.resolve(true);
  }
  // The slots count underlying operations, which only finish after the witness is released.
  await vi.advanceTimersByTimeAsync(0);
  beforeProof.mockResolvedValue(undefined);
  expect(await session.listDialogs()).toEqual([opened]);
});

test("C-ATTN-07 Claude no longer parses raw takeover after native discovery ends", async () => {
  const { session, pty, render } = await setupClaudeAnswer();
  await render(composer);
  const prelude = vi.spyOn(menuMatcher, "readWorkspaceTrustPrelude");
  await session.sendKeys("hello");
  expect(pty.writes).toEqual(["hello"]);
  expect(prelude).not.toHaveBeenCalled();
});
