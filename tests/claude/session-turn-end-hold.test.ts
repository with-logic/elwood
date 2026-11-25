/**
 * Claude mounts its auto-mode offer when a turn's query ends, before the frame that paints
 * it, while Elwood has already reported `ready` on the turn's `Stop` hook. Input queued during
 * the turn waits for that frame, so the offer holds it instead of taking its Enter
 * (C-ATTN-10, C-ATTN-09, PRD §5.3).
 */
import { afterEach, expect, test } from "vitest";
import { createFacadeFixture, nativeHooks, resetAdapters } from "../fixtures/owned-turn/session.ts";
import { tty } from "../fixtures/trust-composer.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";

afterEach(resetAdapters);

/** The captured offer frame without the offer: the composer and footer it painted over. */
const idle = capturedFrame("claude-2.1.332/auto-mode-offer")
  .trimEnd()
  .split("\n")
  .map((line, row) => (row >= 26 && row < 36 ? "" : line))
  .join("\n");
const working = idle.replace(
  "auto mode on (shift+tab to cycle)",
  "auto mode on (shift+tab to cycle) · esc to interrupt",
);
const offer = capturedFrame("claude-2.1.332/auto-mode-offer").trimEnd();
const screen = (text: string, cursor: string) => `\u001b[2J\u001b[H${tty(text)}${cursor}`;
const prompt = "Check: line one.\nLine two.\nReply with exactly OK.";
const paste = `\u001b[200~${prompt}\u001b[201~`;

test("C-ATTN-10 input queued during a turn waits for the end frame and its offer", async () => {
  const { helper, cwd, facade } = createFacadeFixture("claude", {
    initialSize: { cols: 140, rows: 40 },
  });
  const live = await facade.start();
  const pty = helper.ptys[0]!;
  const hooks = nativeHooks("claude", live, cwd, pty);
  try {
    await hooks.ready();
    await expect.poll(() => live.status).toBe("ready");
    pty.emitData(screen(working, "\u001b[38;3H"));
    await hooks.submit("turn-1", "first");
    await expect.poll(() => live.status).toBe("running");
    const sending = live.sendMessage(prompt);
    void sending.catch(() => undefined);

    // The Stop hook ends the turn while the screen still shows it working.
    await hooks.stop("turn-1", "OK");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(pty.writes).toEqual([]);

    // The end frame paints the offer: the whole submission stays held behind it.
    pty.emitData(screen(offer, "\u001b[32;3H"));
    await expect.poll(() => live.status).toBe("blocked");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(pty.writes).toEqual([]);

    // Once the offer closes over the empty composer, the message submits exactly once.
    pty.emitData(screen(idle, "\u001b[38;3H\u001b[?25h"));
    await expect.poll(() => pty.writes).toEqual([paste, "\r"]);
    await sending;
  } finally {
    await facade.teardown();
  }
});
