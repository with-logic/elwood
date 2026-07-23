/**
 * Conformance for the fallback initial-ready transition (PRD §5.3, §5.7, C-API-42):
 * when recording Claude's one-shot initial-ready transition throws (a lifecycle
 * listener), the control queue is still released so queued input is never starved,
 * and a bounded, content-free `initial_ready_fallback` warning surfaces the risk that
 * emitted lifecycle events may be stale. The warning is live-only (never persisted).
 */

import { afterEach, describe, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

const ESC = String.fromCharCode(27);
const PASTE = `${ESC}[200~hello${ESC}[201~`;

afterEach(resetFakes);

async function reachReady(cwd: string, id: string): Promise<void> {
  await ptys[0]!.dispatchHook(id, {
    hook_event_name: "InstructionsLoaded",
    session_id: "claude-1",
    cwd,
    file_path: "/tmp/CLAUDE.md",
    memory_type: "Project",
    load_reason: "session_start",
  });
}

describe("ClaudeSession initial-ready fallback (C-API-42)", () => {
  test("C-API-42 a throwing ready-status listener still releases the queue and warns", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    const queued = session.sendMessage("hello");
    // A rogue listener throws on the `ready` transition: recording initial-ready fails
    // at the EMIT stage, so the queue must still be released directly and a content-free
    // `initial_ready_fallback` warning must surface (live-only, never persisted).
    const warnings: { code: string; raw: string }[] = [];
    session.on("warning", (w) => warnings.push(w));
    session.on("status", (event) => {
      if (event.status === "ready") throw new Error("rogue status listener");
    });
    await reachReady(cwd, session.elwoodSessionId);
    await queued;
    // Anti-starvation: the queued message was released despite the throw.
    expect(ptys[0]!.writes[0]).toBe(PASTE);
    const warning = warnings.find((w) => w.code === "initial_ready_fallback");
    expect(warning).toMatchObject({
      code: "initial_ready_fallback",
      agent: "claude",
      source: "lifecycle",
    });
    expect(warning?.raw).toBe("initial_ready_fallback");
    // The reason field was removed: there is no persist step, only a listener throw.
    expect(warning).not.toHaveProperty("reason");
  });

  test("C-API-42 a throwing WARNING sink during fallback delivery cannot re-starve the queue", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    const queued = session.sendMessage("hello");
    session.on("status", (event) => {
      if (event.status === "ready") throw new Error("rogue status listener");
    });
    // A second rogue listener throws while DELIVERING the fallback warning; the
    // queue release already happened first, so the message is never starved.
    session.on("warning", () => {
      throw new Error("rogue warning sink");
    });
    await reachReady(cwd, session.elwoodSessionId);
    await queued;
    expect(ptys[0]!.writes[0]).toBe(PASTE);
  });
});
