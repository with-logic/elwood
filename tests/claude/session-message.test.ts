/**
 * Conformance tests for Claude adapter-neutral queued messages.
 * Covers PRD §5.3 and C-API-19.
 */

import { afterEach, describe, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("ClaudeSession message submission", () => {
  test("C-API-19 first sendMessage waits for InstructionsLoaded readiness", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    const queued = session.sendMessage("hello");
    expect(ptys[0]!.writes).toEqual([]);
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "InstructionsLoaded",
      session_id: "claude-1",
      cwd,
      file_path: "/tmp/CLAUDE.md",
      memory_type: "Project",
      load_reason: "session_start",
    });
    await queued;
    expect(ptys[0]!.writes).toEqual(["\u001b[200~hello\u001b[201~\r"]);
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "InstructionsLoaded",
      session_id: "claude-1",
      cwd,
      file_path: "/tmp/LOCAL.md",
      memory_type: "Local",
      load_reason: "session_start",
    });
    expect(session.status).toBe("running");
  });
});
