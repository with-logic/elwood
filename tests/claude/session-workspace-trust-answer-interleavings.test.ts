/** Check ownership when a different Claude gate or proof overlaps an answer (C-ATTN-07). */
import { expect, test, vi } from "vitest";
import { tty } from "../fixtures/trust-composer.ts";
import { composer, selectYes, setupClaudeAnswer } from "./workspace-trust-answer-fixture.ts";

const replacement = (screen: string) =>
  screen.replace(
    "   No, exit\r\n ❯ Yes, I trust this folder",
    " ❯ Yes, I trust this folder\r\n   No, exit",
  );

test("C-ATTN-07 raw input during a partial Claude replacement takes over the replacement", async () => {
  const { session, pty, render, menu, request, settle, beforeProof } = await setupClaudeAnswer();
  await render(menu("yes"));
  const original = await request();

  const next = replacement(menu("yes"));
  await render(next.split(" ❯ Yes, I trust this folder")[0]!);
  await session.sendKeys("\x1b[B");
  await render(next);
  const opened = await request();
  expect(opened.id).not.toBe(original.id);
  await settle();

  beforeProof.mockResolvedValueOnce(true);
  const result = session
    .answerDialog(opened.id, opened.choices[0]!.id, { timeoutMs: 250 })
    .catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(250);
  expect(pty.writes).toEqual(["\x1b[B"]);
  expect(await result).toMatchObject({ details: { category: "frame" } });
  expect(await request()).toEqual(opened);
});

test.each([
  false,
  true,
])("C-ATTN-07 an observed Claude replacement cannot acknowledge an earlier confirmation (same layout=%s)", async (sameLayout) => {
  const { session, pty, render, menu, request, settle, beforeProof } = await setupClaudeAnswer();
  await render(menu("yes"));
  const opened = await request();
  await settle();
  const answer = session
    .answerDialog(opened.id, opened.choices[1]!.id)
    .catch((error: unknown) => error);
  await vi.waitFor(() => expect(pty.writes).toEqual([`${selectYes}\r`]));
  await render(tty(""));

  const started = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  beforeProof.mockImplementationOnce(async () => {
    started.resolve();
    await resume.promise;
    return true;
  });
  await render(sameLayout ? menu("yes") : replacement(menu("yes")));
  const listing = session.listDialogs();
  await started.promise;
  try {
    await render(composer);
  } finally {
    resume.resolve();
  }
  await listing;
  expect(await answer).toMatchObject({ details: { category: "frame" } });
  expect(pty.writes).toEqual([`${selectYes}\r`]);
});

test("C-ATTN-07 an abandoned Claude proof cannot revoke another reservation", async () => {
  const { session, pty, render, menu, request, settle, beforeProof } = await setupClaudeAnswer({
    repository: true,
  });
  await render(menu("yes"));
  const opened = await request();
  await settle();
  const firstStarted = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  beforeProof.mockImplementationOnce(async () => {
    firstStarted.resolve();
    await releaseFirst.promise;
    return false;
  });
  const stop = new AbortController();
  const first = session
    .answerDialog(opened.id, opened.choices[1]!.id, { signal: stop.signal })
    .catch((error: unknown) => error);
  await firstStarted.promise;
  stop.abort();
  expect(await first).toMatchObject({ details: { category: "aborted" } });

  const secondStarted = Promise.withResolvers<void>();
  const releaseSecond = Promise.withResolvers<void>();
  beforeProof.mockImplementationOnce(async () => {
    secondStarted.resolve();
    await releaseSecond.promise;
    return undefined;
  });
  const second = session.answerDialog(opened.id, opened.choices[1]!.id);
  void second.catch(() => undefined);
  await secondStarted.promise;
  releaseFirst.resolve();
  await vi.advanceTimersByTimeAsync(0);
  releaseSecond.resolve();
  await vi.waitFor(() => expect(pty.writes).toEqual([`${selectYes}\r`]));
  await render(composer);
  await second;
});

test("C-ATTN-07 raw ownership of a Claude request does not claim its later identical appearance", async () => {
  const { session, pty, render, menu, request, settle } = await setupClaudeAnswer();
  await render(menu("yes"));
  const original = await request();
  await session.sendKeys("\x1b[B");
  await render(tty(""));
  expect(await session.listDialogs()).toEqual([]);
  await expect(session.answerDialog(original.id, original.choices[1]!.id)).rejects.toMatchObject({
    code: "dialog_not_found",
  });
  await render(menu("yes"));

  const reappeared = await request();
  expect(reappeared.id).not.toBe(original.id);
  await settle();
  const accepted = session.answerDialog(reappeared.id, reappeared.choices[1]!.id);
  void accepted.catch(() => undefined);
  await vi.waitFor(() => expect(pty.writes).toEqual(["\x1b[B", `${selectYes}\r`]));
  await render(composer);
  await accepted;
});

test("C-ATTN-07 Claude retries a superseded navigation proof on the newest frame", async () => {
  const { session, pty, render, menu, request, settle, beforeProof } = await setupClaudeAnswer();
  await render(menu("no"));
  const opened = await request();
  await settle();
  const answer = session.answerDialog(opened.id, opened.choices[1]!.id);
  void answer.catch(() => undefined);
  await vi.waitFor(() => expect(pty.writes).toEqual([selectYes]));

  const entered = Promise.withResolvers<void>();
  const proof = Promise.withResolvers<boolean>();
  const latest = Promise.withResolvers<boolean>();
  const checkLatest = vi.fn(() => latest.promise);
  beforeProof.mockImplementationOnce(() => {
    entered.resolve();
    return proof.promise;
  });
  beforeProof.mockImplementationOnce(checkLatest);
  await render(menu("yes"));
  await entered.promise;
  await render(menu("yes"));
  proof.resolve(true);
  await vi.waitFor(() => {
    expect(pty.writes).toEqual([selectYes]);
    expect(checkLatest).toHaveBeenCalledOnce();
  });
  latest.resolve(true);

  await vi.waitFor(() => expect(pty.writes).toEqual([selectYes, `${selectYes}\r`]));
  await render(composer);
  await answer;
});

test.each([
  false,
  true,
])("C-ATTN-07 a Claude proof expiry only retires its current frame (repainted=%s)", async (repainted) => {
  const { session, pty, render, menu, request, settle, beforeProof } = await setupClaudeAnswer();
  await render(menu("yes"));
  const opened = await request();
  await settle();
  const entered = Promise.withResolvers<void>();
  const proof = Promise.withResolvers<boolean>();
  beforeProof.mockImplementationOnce(() => {
    entered.resolve();
    return proof.promise;
  });
  const refused = session
    .answerDialog(opened.id, opened.choices[1]!.id)
    .catch((error: unknown) => error);
  await entered.promise;
  if (repainted) await render(menu("yes"));
  await vi.advanceTimersByTimeAsync(500);
  proof.resolve(true);
  expect(await refused).toMatchObject({ details: { category: "frame" } });
  expect(pty.writes).toEqual([]);
  expect(await session.listDialogs()).toEqual(repainted ? [opened] : []);
});
