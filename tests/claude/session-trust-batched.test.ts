/**
 * A trust gate whose bytes are still held in a render batch holds queued input.
 * Batching delays rendering further than an unbatched write would (PRD §4.1,
 * C-PERF-06), so the input hold must still observe it before deciding
 * (PRD §5.3/§5.4, C-API-56, C-TRUST-01).
 */

import { afterEach, expect, test, vi } from "vitest";
import { type ClaudeSessionApi, startClaude } from "../../src/index.ts";
import { claudeComposer, claudeTrust, tty } from "../fixtures/trust-composer.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

const PASTE = "[200~held[201~";
const clear = "[2J[H";
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

test("C-PERF-06 C-API-56 a trust gate still staged in a render batch holds the submitting Enter", async () => {
  const session = await readySession();
  expect(session.status).toBe("ready");
  const frames: string[] = [];
  session.on("terminal:data", () => frames.push("frame"));
  const queued = session.sendMessage("held");
  await vi.advanceTimersByTimeAsync(149);
  expect(ptys[0]!.writes).toEqual([PASTE]);
  const rendered = frames.length;
  // Received a full millisecond before the Enter is due, but batching holds it back
  // for renderBatchDelayMs, so no frame observes it before the Enter's own timer.
  ptys[0]!.emitData(gate);
  expect(frames.length).toBe(rendered); // still staged: the gate has not been rendered
  await vi.advanceTimersByTimeAsync(2_000);
  expect(ptys[0]!.writes).toEqual([PASTE]); // the Enter did not confirm the gate's option
  ptys[0]!.emitData(composer);
  await vi.advanceTimersByTimeAsync(500);
  await queued;
  expect(ptys[0]!.writes.slice(0, 2)).toEqual([PASTE, "\r"]);
});
