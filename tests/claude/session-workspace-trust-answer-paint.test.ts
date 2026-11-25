/** Exercise ownership and error paths while Claude is still painting (C-ATTN-07). */
import { expect, test, vi } from "vitest";
import { tty } from "../fixtures/trust-composer.ts";
import { bypass, selectYes, setupClaudeAnswer } from "./workspace-trust-answer-fixture.ts";

test.each([
  false,
  true,
])("C-ATTN-07 raw takeover survives a partial Claude question (raw first=%s)", async (rawFirst) => {
  const { session, pty, render, menu, request, settle, beforeProof } = await setupClaudeAnswer();
  const full = menu("yes");
  const disclosure = full.split(" Quick safety check")[0]!;
  const fragment = rawFirst
    ? "quick safety check:is this a project"
    : "Quick safety check: Is this a project";
  const incomplete = `${disclosure} ${fragment}`;
  if (rawFirst) {
    await render(disclosure);
    await session.sendKeys("\x1b[B");
  }
  await render(incomplete);
  if (!rawFirst) await session.sendKeys("\x1b[B");
  await render(full);
  const opened = await request();
  await settle();
  beforeProof.mockResolvedValueOnce(true);
  const closed = session
    .answerDialog(opened.id, opened.choices[1]!.id, { timeoutMs: 250 })
    .catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(250);
  expect(pty.writes).toEqual(["\x1b[B"]);
  expect(await closed).toMatchObject({ details: { category: "frame" } });
});

test("C-ATTN-07 structured Claude refusal after raw takeover spends no proof slot", async () => {
  const { session, pty, render, menu, request, settle, beforeProof } = await setupClaudeAnswer();
  await render(menu("yes"));
  const opened = await request();
  await session.sendKeys("\x1b[B");
  await settle();
  beforeProof.mockClear();
  await expect(session.answerDialog(opened.id, opened.choices[1]!.id)).rejects.toMatchObject({
    details: { category: "frame" },
  });
  expect(beforeProof).not.toHaveBeenCalled();
  expect(pty.writes).toEqual(["\x1b[B"]);
});

test("C-ATTN-07 the legacy complete Bypass Permissions prompt acknowledges workspace acceptance", async () => {
  const { session, pty, render, menu, request, settle } = await setupClaudeAnswer();
  await render(menu("yes"));
  const opened = await request();
  await settle();
  const accepted = session
    .answerDialog(opened.id, opened.choices[1]!.id, { timeoutMs: 250 })
    .catch((error: unknown) => error);
  await vi.waitFor(() => expect(pty.writes).toEqual([`${selectYes}\r`]));
  await render(tty(bypass.replace("Enter to confirm · Esc to cancel", "Enter to confirm")));
  await vi.advanceTimersByTimeAsync(250);
  await expect(accepted).resolves.toBeUndefined();
});

test("C-ATTN-07 a rejected Claude scope lookup fails the owning answer after navigation", async () => {
  const { session, pty, render, menu, request, settle, beforeProof } = await setupClaudeAnswer();
  await render(menu("no"));
  const opened = await request();
  await settle();
  const failed = session
    .answerDialog(opened.id, opened.choices[1]!.id)
    .catch((error: unknown) => error);
  await vi.waitFor(() => expect(pty.writes).toEqual([selectYes]));
  beforeProof.mockRejectedValueOnce(new Error("scripted workspace proof failure"));
  await render(menu("yes"));
  expect(await failed).toMatchObject({ details: { category: "frame" } });
  expect(pty.writes).toEqual([selectYes]);
  expect(await session.listDialogs()).toEqual([opened]);
});
