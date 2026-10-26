/**
 * Claude's runtime cleanup finishes its transcript watcher (PRD §9.4, C-LIFE-12), so a
 * `teardown()` whose PTY could not be terminated leaves no transcript polling behind.
 * Before, only the PTY's exit finished the watcher, and a PTY that outlived teardown kept
 * the session emitting transcript activity.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { startClaude } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(() => {
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

test("C-LIFE-12 a teardown whose PTY outlives it still stops transcript activity", async () => {
  const { session, path, transcript } = await watchingSessionWithStuckPty();
  await expect(session.teardown()).rejects.toMatchObject({ code: "teardown_failed" });
  appendFileSync(path, assistant("written after teardown"));
  await new Promise((resolve) => setTimeout(resolve, TWO_POLLS_MS));
  expect(transcript).toEqual([]);
});

test("C-LIFE-12 runtime cleanup still flushes what the transcript already holds", async () => {
  const { session, path, transcript } = await watchingSessionWithStuckPty();
  appendFileSync(path, assistant("written before teardown"));
  await expect(session.teardown()).rejects.toMatchObject({ code: "teardown_failed" });
  expect(transcript).toMatchObject([
    { type: "assistant", message: { content: [{ text: "written before teardown" }] } },
  ]);
});
