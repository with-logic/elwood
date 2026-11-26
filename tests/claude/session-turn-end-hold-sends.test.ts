/**
 * Two ergonomic sends across an auto-mode turn end, on Claude 2.1.332's captured screens. The
 * first send completes on its `Stop` before awaited input sees an empty composer, so its
 * writer is cancelled with the draft already taken. The second send then finds an idle
 * composer that clear keys would not repaint, after the turn-end hold has kept the screen
 * still. Cleanup releases the taken draft on the writer's own proof, and the second send
 * submits without clear keys (C-API-56, C-ATTN-10, PRD §5.3, §5.8).
 */
import { afterEach, expect, test, vi } from "vitest";
import { idleScreen, offerScreen, workingText } from "../fixtures/offer-frames.ts";
import { createFacadeFixture, nativeHooks, resetAdapters } from "../fixtures/owned-turn/session.ts";

afterEach(resetAdapters);

const first = "Remember the word axolotl.";
const second = "Which word did I ask you to remember?";
const paste = (prompt: string) => `\u001b[200~${prompt}\u001b[201~`;
const clearKeys = "\u0015\u000b";

const until = (ready: () => boolean, timeoutMs = 3_000) =>
  vi.waitFor(
    () => {
      if (!ready()) throw new Error("Not yet");
    },
    { timeout: timeoutMs },
  );

test.each([
  { end: "before the first send completes", paintEndFirst: true },
  { end: "after the first send completes", paintEndFirst: false },
])("C-API-56 C-ATTN-10 a second send follows an auto-mode turn whose end frame paints $end", async ({
  paintEndFirst,
}) => {
  const { helper, cwd, facade } = createFacadeFixture("claude", {
    initialSize: { cols: 140, rows: 40 },
  });
  const live = await facade.start();
  const pty = helper.ptys[0]!;
  const hooks = nativeHooks("claude", live, cwd, pty);
  let replies: Promise<unknown> | undefined;
  try {
    await hooks.ready();
    pty.emitData(idleScreen);
    await until(() => live.status === "ready");

    const firstReply = facade.send(first);
    replies = firstReply.catch(() => undefined);
    await until(() => pty.writes.includes("\r"));
    pty.emitData(offerScreen(workingText));
    await hooks.submit("turn-1", first);
    await until(() => live.status === "running");
    // Claude fires Elwood's `Stop` while it still draws the turn as working.
    await hooks.stop("turn-1");
    if (paintEndFirst) pty.emitData(idleScreen);
    expect(await firstReply).toBe("");
    if (!paintEndFirst) pty.emitData(idleScreen);

    const secondReply = facade.send(second);
    replies = secondReply.catch(() => undefined);
    await until(() => pty.writes.length === 4);
    expect(pty.writes).toEqual([paste(first), "\r", paste(second), "\r"]);
    expect(pty.writes).not.toContain(clearKeys);
    pty.emitData(offerScreen(workingText));
    await hooks.submit("turn-2", second);
    await hooks.stop("turn-2");
    pty.emitData(idleScreen);
    expect(await secondReply).toBe("");
  } finally {
    await facade.teardown();
    await replies;
  }
});
