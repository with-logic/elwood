/**
 * Claude mounts its auto-mode offer when a turn's query ends, before the frame that paints
 * it, while Elwood has already reported `ready` on the turn's `Stop` hook. Input queued during
 * the turn waits for a stable end frame, so the offer holds it instead of taking its Enter,
 * even when a status observer throws; and the hold ends with the next rendered turn
 * (C-ATTN-10, C-ATTN-09, C-API-37, PRD §5.3).
 */
import { afterEach, expect, test } from "vitest";
import { turnEndSettleMs } from "../../src/claude/session/turn-end-hold.ts";
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
const screen = (text: string, cursor = "\u001b[38;3H") => `\u001b[2J\u001b[H${tty(text)}${cursor}`;
const prompt = "Check: line one.\nLine two.\nReply with exactly OK.";
const paste = `\u001b[200~${prompt}\u001b[201~`;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A 140x40 session in a turn, with `prompt` queued behind it. */
async function queuedBehindTurn(onReady?: () => void) {
  const fixture = createFacadeFixture("claude", { initialSize: { cols: 140, rows: 40 } });
  const live = await fixture.facade.start();
  const pty = fixture.helper.ptys[0]!;
  const hooks = nativeHooks("claude", live, fixture.cwd, pty);
  await hooks.ready();
  await expect.poll(() => live.status).toBe("ready");
  pty.emitData(screen(working));
  await hooks.submit("turn-1", "first");
  await expect.poll(() => live.status).toBe("running");
  if (onReady)
    live.on("status", ({ status }) => {
      if (status === "ready") onReady();
    });
  const sending = live.sendMessage(prompt);
  void sending.catch(() => undefined);
  return { ...fixture, live, pty, hooks, sending };
}

test("C-ATTN-10 input queued during a turn waits for the end frame and its offer", async () => {
  const { facade, pty, live, hooks, sending } = await queuedBehindTurn();
  try {
    // The Stop hook ends the turn while the screen still shows it working.
    await hooks.stop("turn-1", "OK");
    await wait(400);
    expect(pty.writes).toEqual([]);

    // The end frame paints the offer: the whole submission stays held behind it.
    pty.emitData(screen(offer, "\u001b[32;3H"));
    await expect.poll(() => live.status).toBe("blocked");
    await wait(400);
    expect(pty.writes).toEqual([]);

    // Once the offer closes over the empty composer, the message submits exactly once.
    pty.emitData(screen(idle, "\u001b[38;3H\u001b[?25h"));
    await expect.poll(() => pty.writes, { timeout: 3_000 }).toEqual([paste, "\r"]);
    await sending;
  } finally {
    await facade.teardown();
  }
});

test("C-ATTN-10 an end frame without the offer releases nothing until it has stayed unchanged", async () => {
  const { facade, pty, live, hooks, sending } = await queuedBehindTurn();
  try {
    await hooks.stop("turn-1", "OK");
    // Claude clears its working indicator before the offer it has already mounted paints.
    pty.emitData(screen(idle, "\u001b[38;3H\u001b[?25h"));
    await wait(turnEndSettleMs / 2);
    expect(pty.writes).toEqual([]);
    pty.emitData(screen(offer, "\u001b[32;3H"));
    await expect.poll(() => live.status).toBe("blocked");
    await wait(turnEndSettleMs + 200);
    expect(pty.writes).toEqual([]);
    pty.emitData(screen(idle, "\u001b[38;3H\u001b[?25h"));
    await expect.poll(() => pty.writes, { timeout: 3_000 }).toEqual([paste, "\r"]);
    await sending;
  } finally {
    await facade.teardown();
  }
});

test("C-ATTN-10 a status observer that throws at the turn's ready does not skip the hold", async () => {
  const { facade, pty, hooks, sending } = await queuedBehindTurn(() => {
    throw new Error("status observer failed");
  });
  try {
    await hooks.stop("turn-1", "OK");
    await wait(400);
    expect(pty.writes).toEqual([]);
    pty.emitData(screen(idle, "\u001b[38;3H\u001b[?25h"));
    await expect.poll(() => pty.writes, { timeout: 3_000 }).toEqual([paste, "\r"]);
    await sending;
  } finally {
    await facade.teardown();
  }
});

test("C-ATTN-10 a turn that ends on screen before its Stop holds input, even when an observer throws", async () => {
  const { facade, pty, live, sending } = await queuedBehindTurn(() => {
    throw new Error("status observer failed");
  });
  try {
    // No Stop yet: the rendered end alone reaches `ready`, and its observer throws. The
    // queued send then starts, so the session reads `running` while its writes wait.
    pty.emitData(screen(idle, "\u001b[38;3H\u001b[?25h"));
    await expect
      .poll(() => live.statusDecisions().map(({ evidence, to }) => `${evidence}:${to}`))
      .toContain("rendered_turn_ended:ready");
    await wait(turnEndSettleMs / 2);
    expect(pty.writes).toEqual([]);
    pty.emitData(screen(offer, "\u001b[32;3H"));
    await expect.poll(() => live.status).toBe("blocked");
    await wait(turnEndSettleMs + 200);
    expect(pty.writes).toEqual([]);
    pty.emitData(screen(idle, "\u001b[38;3H\u001b[?25h"));
    await expect.poll(() => pty.writes, { timeout: 3_000 }).toEqual([paste, "\r"]);
    await sending;
  } finally {
    await facade.teardown();
  }
});

test("C-ATTN-10 C-API-37 the next rendered turn ends the last turn's hold", async () => {
  const fixture = createFacadeFixture("claude", { initialSize: { cols: 140, rows: 40 } });
  const live = await fixture.facade.start();
  const pty = fixture.helper.ptys[0]!;
  const hooks = nativeHooks("claude", live, fixture.cwd, pty);
  try {
    await hooks.ready();
    await expect.poll(() => live.status).toBe("ready");
    pty.emitData(screen(working));
    await hooks.submit("turn-1", "first");
    await expect.poll(() => live.status).toBe("running");
    await hooks.stop("turn-1", "OK");
    await expect.poll(() => live.status).toBe("ready");
    // Nothing is queued while the end frame shows; then the next turn renders, as one a
    // human typed into the terminal does.
    pty.emitData(screen(idle, "\u001b[38;3H\u001b[?25h"));
    await expect.poll(() => live.statusDecisions().at(-1)?.evidence).toBe("rendered_turn_ended");
    pty.emitData(screen(working.replace("Probe Offer", "Probe Offer, again")));
    await expect.poll(() => live.status).toBe("running");
    const guidance = live.sendGuidance("also check the tests");
    await expect
      .poll(() => pty.writes, { timeout: turnEndSettleMs })
      .toEqual(["\u001b[200~also check the tests\u001b[201~", "\r"]);
    await guidance;
  } finally {
    await fixture.facade.teardown();
  }
});
