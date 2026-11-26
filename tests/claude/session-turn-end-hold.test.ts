/**
 * Claude mounts its auto-mode offer when a turn's query ends, before the frame that paints
 * it, while Elwood may already report `ready`. Input queued during the turn waits for a
 * stable end frame, however the turn ends and even when a status observer throws, so the
 * offer holds it instead of taking its Enter while Elwood declines the offer; and resumed
 * work ends the hold (C-ATTN-10, C-ATTN-09, C-CLAUDE-26, C-API-37, PRD §5.3).
 */
import { afterEach, expect, test, vi } from "vitest";
import { turnEndSettleMs } from "../../src/claude/session/turn-end-hold.ts";
import type { ClaudeSessionApi } from "../../src/index.ts";
import {
  idleScreen,
  offerOnScreen,
  offerScreen,
  permissionScreen,
  workingText,
} from "../fixtures/offer-frames.ts";
import { createFacadeFixture, nativeHooks, resetAdapters } from "../fixtures/owned-turn/session.ts";
import type { FakePty } from "../helpers/fake-pty.ts";

afterEach(resetAdapters);

const prompt = "Check: line one.\nLine two.\nReply with exactly OK.";
const paste = `\u001b[200~${prompt}\u001b[201~`;
const guidance = "also check the tests";
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A 140x40 auto-mode session in a turn; `onReady` observes every later `ready`. */
async function inTurn(onReady?: () => void) {
  const fixture = createFacadeFixture("claude", { initialSize: { cols: 140, rows: 40 } });
  const live = await fixture.facade.start();
  const pty = fixture.helper.ptys[0]!;
  const hooks = nativeHooks("claude", live, fixture.cwd, pty);
  await hooks.ready();
  await until(() => live.status === "ready");
  pty.emitData(offerScreen(workingText));
  await hooks.submit("turn-1", "first");
  await until(() => live.status === "running");
  if (onReady)
    live.on("status", ({ status }) => {
      if (status === "ready") onReady();
    });
  return { facade: fixture.facade, live, pty, hooks };
}

/** The same, with `prompt` queued behind the turn. */
async function queuedBehindTurn(onReady?: () => void) {
  const turn = await inTurn(onReady);
  const sending = turn.live.sendMessage(prompt);
  void sending.catch(() => undefined);
  return { ...turn, sending };
}

const decisions = (live: ClaudeSessionApi) =>
  live.statusDecisions().map(({ evidence, to }) => `${evidence}:${to}`);

/** Waits for `ready()` without asserting, so that helpers can share it. */
const until = (ready: () => boolean, timeoutMs = 1_000) =>
  vi.waitFor(
    () => {
      if (!ready()) throw new Error("Not yet");
    },
    { timeout: timeoutMs },
  );

/**
 * What was written before the offer painted, behind it until Elwood's own decline went out
 * (C-CLAUDE-26), and once it closed.
 */
async function writesAroundOffer(live: ClaudeSessionApi, pty: FakePty) {
  await wait(turnEndSettleMs / 2);
  const before = [...pty.writes];
  pty.emitData(offerOnScreen);
  await until(() => live.status === "blocked");
  await until(() => pty.writes.length > 0, 3_000);
  await wait(100);
  const behind = [...pty.writes];
  pty.emitData(idleScreen);
  await until(() => pty.writes.length >= 3, 3_000);
  return { before, behind, after: [...pty.writes] };
}

/** Only the decline goes out behind the offer; once it closes, the message submits once. */
const heldBehindOffer = { before: [], behind: ["\u001b"], after: ["\u001b", paste, "\r"] };

const throwing = () => {
  throw new Error("status observer failed");
};

test("C-ATTN-10 input queued during a turn waits past its Stop for the offer", async () => {
  const { facade, pty, live, hooks, sending } = await queuedBehindTurn();
  try {
    // The Stop hook ends the turn while the screen still shows it working.
    await hooks.stop("turn-1", "OK");
    await wait(400);
    expect(await writesAroundOffer(live, pty)).toEqual(heldBehindOffer);
    await sending;
  } finally {
    await facade.teardown();
  }
});

test("C-ATTN-10 an end frame without the offer releases nothing until it has stayed unchanged", async () => {
  const { facade, pty, live, hooks, sending } = await queuedBehindTurn();
  try {
    await hooks.stop("turn-1", "OK");
    // A frame that shows neither the turn working nor the offer Claude has mounted.
    pty.emitData(idleScreen);
    expect(await writesAroundOffer(live, pty)).toEqual(heldBehindOffer);
    await sending;
  } finally {
    await facade.teardown();
  }
});

test("C-ATTN-10 a status observer that throws at the Stop's ready does not skip the hold", async () => {
  const { facade, pty, live, hooks, sending } = await queuedBehindTurn(throwing);
  try {
    await hooks.stop("turn-1", "OK");
    expect(await writesAroundOffer(live, pty)).toEqual(heldBehindOffer);
    await sending;
  } finally {
    await facade.teardown();
  }
});

test("C-ATTN-10 a turn that ends on screen before its Stop holds input, even when an observer throws", async () => {
  const { facade, pty, live, sending } = await queuedBehindTurn(throwing);
  try {
    // The rendered end alone reaches `ready`, and its observer throws. The queued send
    // then starts, so the session reads `running` while its writes wait.
    pty.emitData(idleScreen);
    await expect.poll(() => decisions(live)).toContain("rendered_turn_ended:ready");
    expect(await writesAroundOffer(live, pty)).toEqual(heldBehindOffer);
    await sending;
  } finally {
    await facade.teardown();
  }
});

test("C-ATTN-10 a turn that a dismissed dialog ends holds input past that dialog", async () => {
  const { facade, pty, live, sending } = await queuedBehindTurn();
  try {
    pty.emitData(permissionScreen);
    await expect.poll(() => live.status).toBe("blocked");
    // Dismissing the dialog ends the turn: one frame shows the idle composer in its place.
    pty.emitData(idleScreen);
    await expect.poll(() => decisions(live)).toContain("blocking_prompt_cleared:ready");
    expect(await writesAroundOffer(live, pty)).toEqual(heldBehindOffer);
    await sending;
  } finally {
    await facade.teardown();
  }
});

test("C-ATTN-10 C-API-37 the next rendered turn ends the last turn's hold", async () => {
  const { facade, pty, live, hooks } = await inTurn();
  try {
    await hooks.stop("turn-1", "OK");
    await expect.poll(() => live.status).toBe("ready");
    // Nothing is queued while the end frame shows; then the next turn renders, as one a
    // human typed into the terminal does.
    pty.emitData(idleScreen);
    await expect.poll(() => live.statusDecisions().at(-1)?.evidence).toBe("rendered_turn_ended");
    pty.emitData(offerScreen(workingText.replace("Probe Offer", "Probe Offer, again")));
    await expect.poll(() => live.status).toBe("running");
    const sending = live.sendGuidance(guidance);
    await expect
      .poll(() => pty.writes, { timeout: turnEndSettleMs })
      .toEqual([`\u001b[200~${guidance}\u001b[201~`, "\r"]);
    await sending;
  } finally {
    await facade.teardown();
  }
});

test("C-ATTN-10 C-API-37 work that resumes as a dialog clears ends the last turn's hold", async () => {
  const { facade, pty, live, hooks } = await inTurn();
  try {
    await hooks.stop("turn-1", "OK");
    await expect.poll(() => live.status).toBe("ready");
    pty.emitData(permissionScreen);
    await expect.poll(() => live.status).toBe("blocked");
    pty.emitData(offerScreen(workingText.replace("Probe Offer", "Probe Offer, again")));
    await expect.poll(() => decisions(live)).toContain("blocking_prompt_cleared:running");
    const sending = live.sendGuidance(guidance);
    await expect
      .poll(() => pty.writes, { timeout: turnEndSettleMs })
      .toEqual([`\u001b[200~${guidance}\u001b[201~`, "\r"]);
    await sending;
  } finally {
    await facade.teardown();
  }
});
