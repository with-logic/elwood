/**
 * A trust gate that is still in received-but-unrendered PTY output holds queued input.
 * Rendering is asynchronous (PRD §4.1), so the input hold must observe everything
 * already received before it decides (PRD §5.3/§5.4, C-API-56, C-TRUST-01).
 */

import { afterEach, expect, test, vi } from "vitest";
import { type ClaudeSessionApi, startClaude } from "../../src/index.ts";
import { claudeComposer, claudeTrust, tty } from "../fixtures/trust-composer.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

const PASTE = "\u001b[200~held\u001b[201~";
const clear = "\u001b[2J\u001b[H";
const gate = `${clear}${tty(claudeTrust)}\r\n1. Yes\r\n2. No`;
const composer = `${clear}${tty(claudeComposer)}`;

const sessions: ClaudeSessionApi[] = [];

// Teardown is unconditional, so a failed assertion cannot leak a bridge, PTY, or timers.
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(sessions.splice(0).map((session) => session.teardown()));
  resetFakes();
});

/** A ready session on fake timers, so a test controls exactly when a frame renders. */
async function readySession(): Promise<ClaudeSessionApi> {
  installFakes();
  const session = await startClaude({ cwd: tempDir() });
  sessions.push(session);
  vi.useFakeTimers();
  ptys[0]!.emitData("Claude ready\r\n❯ ");
  await vi.advanceTimersByTimeAsync(10_010);
  return session;
}

test("C-API-56 a trust gate received but not yet rendered holds the whole queued paste", async () => {
  const session = await readySession();
  expect(session.status).toBe("ready");
  // Same tick: the gate's bytes are received (staged for rendering) but no frame has
  // been observed, so the last observed screen is still the composer.
  ptys[0]!.emitData(gate);
  const queued = session.sendMessage("held");
  await vi.advanceTimersByTimeAsync(2_000);
  expect(ptys[0]!.writes).toEqual([]); // neither the paste nor an Enter reached the gate
  expect(session.status).toBe("blocked");
  ptys[0]!.emitData(composer);
  await vi.advanceTimersByTimeAsync(500);
  await queued;
  expect(ptys[0]!.writes).toEqual([PASTE, "\r"]);
});

test("C-API-56 a trust gate received in the turn the Enter is due holds the submitting Enter", async () => {
  const session = await readySession();
  expect(session.status).toBe("ready");
  // Registered before the submission, so at the 150 ms tick this runs just BEFORE the
  // Enter's own timer: the gate is received, but unrendered, as the Enter decides.
  setTimeout(() => ptys[0]!.emitData(gate), 150);
  const queued = session.sendMessage("held");
  await vi.advanceTimersByTimeAsync(10);
  ptys[0]!.emitData(`${clear}❯ [Pasted text #1 +3 lines]`); // the TUI echoes the staged paste
  await vi.advanceTimersByTimeAsync(139);
  expect(ptys[0]!.writes).toEqual([PASTE]);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(ptys[0]!.writes).toEqual([PASTE]); // the Enter did not confirm the gate's option
  ptys[0]!.emitData(composer);
  await vi.advanceTimersByTimeAsync(500);
  await queued;
  expect(ptys[0]!.writes.slice(0, 2)).toEqual([PASTE, "\r"]);
});

test("C-API-56 a trust gate received in the turn a recovery nudge is due holds the recovery Enter", async () => {
  const session = await readySession();
  expect(session.status).toBe("ready");
  // The first Enter lands at 150 ms and its recovery nudge is due 1,000 ms later; as
  // above, this earlier-registered timer delivers the gate just before the nudge runs.
  setTimeout(() => ptys[0]!.emitData(`${gate}\r\n[Pasted text #1 +3 lines]`), 1_150);
  const queued = session.sendMessage("held");
  await vi.advanceTimersByTimeAsync(150);
  await queued;
  // The paste still shows as staged, so the nudge would otherwise re-send Enter.
  ptys[0]!.emitData(`${clear}❯ [Pasted text #1 +3 lines]`);
  await vi.advanceTimersByTimeAsync(999);
  expect(ptys[0]!.writes).toEqual([PASTE, "\r"]);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(ptys[0]!.writes).toEqual([PASTE, "\r"]); // no recovery Enter reached the gate
});

test("C-API-56 a trust gate received while an earlier chunk is still settling holds the paste", async () => {
  const session = await readySession();
  ptys[0]!.emitData("\r\nthinking"); // an ordinary chunk is mid-render as the write is queued
  const queued = session.sendMessage("held");
  for (let turn = 0; turn < 10; turn++) await Promise.resolve(); // the barrier is now waiting
  ptys[0]!.emitData(gate); // received during that wait, behind the first chunk
  await vi.advanceTimersByTimeAsync(2_000);
  expect(ptys[0]!.writes).toEqual([]);
  ptys[0]!.emitData(composer);
  await vi.advanceTimersByTimeAsync(500);
  await queued;
  expect(ptys[0]!.writes).toEqual([PASTE, "\r"]);
});

test("C-API-56 a gate whose render failed holds the paste until a later frame renders", async () => {
  const session = await readySession();
  vi.spyOn(session.terminal.xterm, "write").mockImplementationOnce(() => {
    throw new Error("render failed");
  });
  ptys[0]!.emitData(gate); // never parsed: the screen Elwood last observed is stale
  const queued = session.sendMessage("held");
  await vi.advanceTimersByTimeAsync(2_000);
  expect(ptys[0]!.writes).toEqual([]);
  ptys[0]!.emitData(composer);
  await vi.advanceTimersByTimeAsync(500);
  await queued;
  expect(ptys[0]!.writes).toEqual([PASTE, "\r"]);
});

test("C-API-56 a PTY that never goes quiet holds the write, and cancelling still releases the queue", async () => {
  const session = await readySession();
  // Each render takes 5 ms and output arrives every millisecond: no settle pass ever
  // completes with nothing new received.
  const slow = vi.spyOn(session.terminal.xterm, "write").mockImplementation((_data, done) => {
    setTimeout(() => done?.(), 5);
  });
  const chatter = setInterval(() => ptys[0]!.emitData("."), 1);
  await vi.advanceTimersByTimeAsync(20); // the flood is under way before the command is queued
  const compacting = session.compact({ timeoutMs: 1_500 });
  const rejected = expect(compacting).rejects.toMatchObject({ code: "compact_failed" });
  await vi.advanceTimersByTimeAsync(1_600);
  await rejected;
  expect(ptys[0]!.writes).toEqual([]); // held for the whole flood, never written through
  clearInterval(chatter);
  slow.mockRestore();
  const queued = session.sendMessage("held");
  await vi.advanceTimersByTimeAsync(10_000); // the backlog renders, then the write is safe
  await queued;
  expect(ptys[0]!.writes).toEqual([PASTE, "\r"]);
});

test("C-API-56 a trust gate received in the turn the compact recovery Enter is due holds it", async () => {
  const session = await readySession();
  // `/compact` and its Enter land by 150 ms; the recovery Enter is due 2,000 ms later.
  // Registered first, this timer delivers the gate just before that nudge runs.
  setTimeout(() => ptys[0]!.emitData(gate), 2_150);
  const compacting = session.compact({ timeoutMs: 4_000 });
  const rejected = expect(compacting).rejects.toMatchObject({ code: "compact_failed" });
  await vi.advanceTimersByTimeAsync(200);
  ptys[0]!.emitData(`${clear}❯ /compact`); // the TUI echoes the command
  await vi.advanceTimersByTimeAsync(4_000);
  await rejected;
  expect(ptys[0]!.writes).toEqual(["/compact", "\r"]); // no recovery Enter reached the gate
});
