/**
 * Replays real Codex 0.164.0 resume output through a resumed session: the CLI's
 * "Resuming session…" placeholder, its conversation load under a working title, and
 * the replayed transcript must not fabricate a turn after readiness (PRD §5.3,
 * C-TURN-03, C-API-28). `completed-turn` resumes a conversation whose last turn
 * committed; `uncommitted-turn` resumes one stopped before Codex wrote the turn's
 * completion, so the replay ends in "Conversation interrupted".
 */
import { readFileSync } from "node:fs";
import { afterEach, expect, test } from "vitest";
import { isRecord } from "../../src/core/predicates.ts";
import { resumeCodex, startCodex } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

/** The captured PTY chunks, in delivery order; throws on a fixture of any other shape. */
function capturedChunks(name: string): readonly string[] {
  const url = new URL(`../fixtures/codex-0.164.0/resume/${name}.json`, import.meta.url);
  const parsed: unknown = JSON.parse(readFileSync(url, "utf8"));
  const chunks = isRecord(parsed) ? parsed["chunks"] : undefined;
  if (!Array.isArray(chunks) || chunks.length === 0)
    throw new Error(`${name}: expected non-empty chunks`);
  return chunks.map((chunk: unknown, index) => {
    const data = isRecord(chunk) ? chunk["data"] : undefined;
    if (typeof data !== "string") throw new Error(`${name}: chunk ${index} has no string data`);
    return data;
  });
}

test.each([
  "completed-turn",
  "uncommitted-turn",
])("C-TURN-03 a replayed Codex 0.164.0 resume (%s) emits no status after ready", async (name) => {
  installFakes();
  const cwd = tempDir();
  const original = await startCodex({ cwd });
  try {
    await ptys[0]!.dispatchHook(original.elwoodSessionId, {
      hook_event_name: "SessionStart",
      session_id: "codex-resume",
      cwd,
      source: "startup",
      model: "fixture",
    });
  } finally {
    await original.stop();
  }
  const session = await resumeCodex({ cwd, elwoodSessionId: original.elwoodSessionId });
  const statuses: string[] = [];
  session.on("status", (event) => statuses.push(event.status));
  try {
    // One captured PTY chunk per rendered frame, as the real CLI delivered them.
    for (const chunk of capturedChunks(name)) {
      ptys[1]!.emitData(chunk);
      await session.terminal.settled();
    }
    expect(statuses).toEqual(["ready"]);
    expect(session.terminal.snapshot().text).not.toContain("Resuming session…");
  } finally {
    await session.stop();
  }
});
