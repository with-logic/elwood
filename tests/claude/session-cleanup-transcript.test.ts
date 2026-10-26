/**
 * Claude's runtime cleanup finishes its transcript watcher (PRD §9.4, C-LIFE-12), so a
 * shutdown whose PTY could not be terminated leaves no transcript polling behind.
 * Before, only the PTY's exit finished the watcher, and a PTY that outlived the shutdown
 * kept the session emitting transcript activity. Only intervals are faked, so the
 * watcher polls only when a test advances them and no poll can stand in for the flush.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { startClaude } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetFakes();
});

// The watcher polls every 500 ms, so this spans two polls.
const TWO_POLLS_MS = 1_100;

const assistant = (text: string) =>
  `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } })}\n`;

/** A session watching an empty transcript, whose PTY can't be signaled and so never exits. */
async function watchingSessionWithStuckPty() {
  installFakes();
  const cwd = tempDir();
  const path = join(cwd, "transcript.jsonl");
  writeFileSync(path, "");
  const session = await startClaude({ cwd });
  const pty = ptys[0]!;
  const transcript: unknown[] = [];
  session.on("activity", (event) => {
    if (event.source === "transcript") transcript.push(event.raw);
  });
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  await pty.dispatchHook(session.elwoodSessionId, {
    hook_event_name: "Stop",
    session_id: "claude-1",
    cwd,
    transcript_path: path,
  });
  // A PTY that never exits never finishes the watcher itself.
  vi.spyOn(pty, "kill").mockImplementation(() => {
    throw Object.assign(new Error("EIO"), { code: "EIO" });
  });
  return { session, path, transcript };
}

test("C-LIFE-12 the watcher polls the transcript while the session runs", async () => {
  const { session, path, transcript } = await watchingSessionWithStuckPty();
  appendFileSync(path, assistant("written while running"));
  await vi.advanceTimersByTimeAsync(TWO_POLLS_MS);
  await expect.poll(() => transcript.length).toBe(1);
  await session.teardown().catch(() => undefined);
});

test.each([
  ["stop", "termination_failed"],
  ["kill", "termination_failed"],
  ["teardown", "teardown_failed"],
] as const)("C-LIFE-12 a %s whose PTY outlives it stops transcript polling", async (verb, code) => {
  const { session, path, transcript } = await watchingSessionWithStuckPty();
  await expect(session[verb]()).rejects.toMatchObject({ code });
  expect(vi.getTimerCount()).toBe(0); // The watcher's poll interval is gone.
  appendFileSync(path, assistant("written after the shutdown"));
  await vi.advanceTimersByTimeAsync(TWO_POLLS_MS);
  expect(transcript).toEqual([]);
  await session.teardown().catch(() => undefined);
});

test("C-LIFE-12 runtime cleanup still flushes what the transcript already holds", async () => {
  const { session, path, transcript } = await watchingSessionWithStuckPty();
  appendFileSync(path, assistant("written before teardown"));
  await expect(session.teardown()).rejects.toMatchObject({ code: "teardown_failed" });
  expect(transcript).toMatchObject([
    { type: "assistant", message: { content: [{ text: "written before teardown" }] } },
  ]);
});

test("C-LIFE-12 a failed final flush at runtime cleanup does not claim the PTY exited", async () => {
  const { session, path } = await watchingSessionWithStuckPty();
  session.on("activity", (event) => {
    if (event.source === "transcript") throw new Error("consumer transcript failure");
  });
  const warnings: { readonly phase?: unknown; readonly message: string }[] = [];
  session.on("warning", (warning) => {
    if (warning.code === "transcript_poll_stopped") warnings.push(warning);
  });
  appendFileSync(path, assistant("written before teardown"));
  await expect(session.teardown()).rejects.toMatchObject({ code: "teardown_failed" });
  await expect.poll(() => warnings.length).toBe(1);
  expect(warnings[0]).toMatchObject({ phase: "final_flush" });
  expect(warnings[0]!.message).not.toMatch(/exit/);
});
