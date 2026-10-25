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
import { resumeCodex, startCodex } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

type Capture = { readonly chunks: readonly { readonly data: string }[] };
const capture = (name: string): Capture =>
  JSON.parse(
    readFileSync(new URL(`../fixtures/codex-0.164.0/resume/${name}.json`, import.meta.url), "utf8"),
  ) as Capture;

test.each([
  "completed-turn",
  "uncommitted-turn",
])("C-TURN-03 a replayed Codex 0.164.0 resume (%s) emits no status after ready", async (name) => {
  installFakes();
  const cwd = tempDir();
  const original = await startCodex({ cwd });
  await ptys[0]!.dispatchHook(original.elwoodSessionId, {
    hook_event_name: "SessionStart",
    session_id: "codex-resume",
    cwd,
    source: "startup",
    model: "fixture",
  });
  await original.stop();
  const session = await resumeCodex({ cwd, elwoodSessionId: original.elwoodSessionId });
  const statuses: string[] = [];
  session.on("status", (event) => statuses.push(event.status));
  try {
    // One captured PTY chunk per rendered frame, as the real CLI delivered them.
    for (const chunk of capture(name).chunks) {
      ptys[1]!.emitData(chunk.data);
      await session.terminal.settled();
    }
    expect(statuses).toEqual(["ready"]);
    expect(session.terminal.snapshot().text).not.toContain("Resuming session…");
  } finally {
    await session.stop();
  }
});
