/**
 * When the turn-end hold's 5-second limit releases input that still waited on a screen that
 * never settled, Elwood reports it once with a content-free warning, delivered so that a
 * throwing listener cannot stop the input. A dialog that held the input past the limit is
 * not reported (C-ATTN-10, PRD §5.3, §5.7).
 */
import { afterEach, expect, test, vi } from "vitest";
import { turnEndPaintLimitMs } from "../../src/claude/session/turn-end-hold.ts";
import type { ElwoodWarningEvent } from "../../src/index.ts";
import {
  idleScreen,
  idleText,
  offerOnScreen,
  offerScreen,
  workingText,
} from "../fixtures/offer-frames.ts";
import { createFacadeFixture, nativeHooks, resetAdapters } from "../fixtures/owned-turn/session.ts";

afterEach(resetAdapters);

const paste = "\u001b[200~queued\u001b[201~";
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Waits for `ready()` without asserting, so that helpers can share it. */
const until = (ready: () => boolean, timeoutMs = 1_000) =>
  vi.waitFor(
    () => {
      if (!ready()) throw new Error("Not yet");
    },
    { timeout: timeoutMs },
  );

/** An auto-mode session that has ended a turn with `queued` behind it. */
async function endedWithQueued() {
  const fixture = createFacadeFixture("claude", { initialSize: { cols: 140, rows: 40 } });
  const live = await fixture.facade.start();
  const pty = fixture.helper.ptys[0]!;
  const hooks = nativeHooks("claude", live, fixture.cwd, pty);
  await hooks.ready();
  await until(() => live.status === "ready");
  pty.emitData(offerScreen(workingText));
  await hooks.submit("turn-1", "first");
  await until(() => live.status === "running");
  const warnings: ElwoodWarningEvent[] = [];
  const labels: string[] = [];
  live.on("warning", (warning) => {
    warnings.push(warning);
    throw new Error("warning listener failed");
  });
  live.on("activity", ({ kind, label }) => {
    if (kind === "warning" && label !== undefined) labels.push(label);
  });
  const sending = live.sendMessage("queued");
  void sending.catch(() => undefined);
  await hooks.stop("turn-1", "OK");
  return { facade: fixture.facade, pty, sending, warnings, labels, stopped: Date.now() };
}

test("C-ATTN-10 the limit reports input it releases from a screen that never settled", async () => {
  const { facade, pty, sending, warnings, labels, stopped } = await endedWithQueued();
  try {
    // Claude's composer, idle, but repainted with new transcript text every 100 ms, until
    // the queued paste goes out.
    for (let tick = 0; pty.writes.length === 0; tick += 1) {
      expect(Date.now() - stopped).toBeLessThan(turnEndPaintLimitMs + 2_000);
      pty.emitData(offerScreen(idleText.replace(/^.*$/m, `tick ${tick}`)));
      await wait(100);
    }
    expect(Date.now() - stopped).toBeGreaterThanOrEqual(turnEndPaintLimitMs - 100);
    await expect.poll(() => pty.writes, { timeout: 3_000 }).toEqual([paste, "\r"]);
    await sending;
    expect(warnings).toEqual([
      {
        elwoodSessionId: expect.any(String),
        agent: "claude",
        source: "terminal",
        code: "turn_end_hold_expired",
        severity: "warning",
        message:
          "Queued input was released at the turn-end hold's limit, without a stable composer frame.",
        raw: "turn_end_hold_expired",
      },
    ]);
    expect(labels).toEqual(["turn_end_hold_expired"]);
  } finally {
    await facade.teardown();
  }
});

test("C-ATTN-10 a dialog that held the input past the limit is not reported", async () => {
  const { facade, pty, sending, warnings } = await endedWithQueued();
  try {
    // The hold reads an idle screen that has not settled yet, then the offer paints and stays.
    pty.emitData(idleScreen);
    await wait(300);
    pty.emitData(offerOnScreen);
    await wait(turnEndPaintLimitMs + 500);
    pty.emitData(idleScreen);
    await expect.poll(() => pty.writes.includes(paste), { timeout: 3_000 }).toBe(true);
    await sending;
    await wait(100);
    expect(warnings).toEqual([]);
  } finally {
    await facade.teardown();
  }
});
