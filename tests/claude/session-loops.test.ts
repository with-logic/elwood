/** Claude recurring-loop parity tests (PRD §5.9, C-LOOP-01/02/12/16). */

import { afterEach, describe, expect, test } from "vitest";
import type { ElwoodLoopEvent } from "../../src/index.ts";
import { resumeClaude, startClaude } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("ClaudeSessionApi recurring loops", () => {
  test("C-LOOP-01/02/16 manages loops without intercepting literal slash text", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    const events: ElwoodLoopEvent[] = [];
    session.on("loop", (event) => events.push(event));
    const loop = await session.createLoop({ mode: "idle", message: "check status" });
    expect(await session.listLoops()).toEqual([loop]);

    const sent = session.sendMessage("/loop 5m remains literal");
    await ready(session.elwoodSessionId, cwd, "claude-1");
    await sent;
    expect(ptys[0]!.writes.join("")).toContain("/loop 5m remains literal");
    expect(await session.listLoops()).toHaveLength(1);
    await session.cancelLoop(loop.id);
    expect(await session.listLoops()).toEqual([]);
    expect(JSON.stringify(events)).not.toContain("check status");
  });

  test("C-LOOP-12 resume preserves identity and starts from waiting", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    const loop = await session.createLoop({ mode: "fixed", intervalMs: 60_000, message: "tick" });
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "SessionStart",
      session_id: "claude-resume",
      cwd,
      source: "startup",
    });
    await ready(session.elwoodSessionId, cwd, "claude-resume");
    await session.stop();

    const resumed = await resumeClaude({ cwd, elwoodSessionId: session.elwoodSessionId });
    expect(await resumed.listLoops()).toEqual([
      expect.objectContaining({ id: loop.id, jitterMs: loop.jitterMs, state: "waiting" }),
    ]);
    await resumed.teardown();
  });
});

function ready(elwoodSessionId: string, cwd: string, sessionId: string) {
  return ptys.at(-1)!.dispatchHook(elwoodSessionId, {
    hook_event_name: "InstructionsLoaded",
    session_id: sessionId,
    cwd,
    file_path: "/tmp/CLAUDE.md",
    memory_type: "Project",
    load_reason: "session_start",
  });
}
