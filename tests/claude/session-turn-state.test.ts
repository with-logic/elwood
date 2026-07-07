/**
 * Conformance tests for rendered-TUI turn boundaries on Claude sessions.
 * Covers PRD §5.3, C-TURN-01, and C-TURN-02.
 */

import { afterEach, describe, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

const instructionsLoaded = (cwd: string) => ({
  hook_event_name: "InstructionsLoaded",
  session_id: "claude-1",
  cwd,
  file_path: "/tmp/CLAUDE.md",
  memory_type: "Project",
  load_reason: "session_start",
});

const workingFooter = "❯ \r\n  ⏵⏵ bypass permissions · esc to interrupt · ← for agents";
const idleFooter = "❯ \r\n  ⏵⏵ bypass permissions · ← for agents";

describe("ClaudeSession turn boundaries", () => {
  test("C-TURN-02 an interrupted turn transitions to ready without a Stop hook", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    const statuses: string[] = [];
    session.on("status", (event) => statuses.push(event.status));
    await ptys[0]!.dispatchHook(session.elwoodSessionId, instructionsLoaded(cwd));
    expect(session.status).toBe("ready");
    // A turn starts: the rendered footer shows the working token.
    ptys[0]!.emitData(workingFooter);
    await expect.poll(() => session.status).toBe("running");
    // Escape interrupt: the token disappears, the composer is back — and no
    // Stop hook ever fires. The session must still return to ready.
    ptys[0]!.emitData(`\u001b[2J\u001b[H${idleFooter}`);
    await expect.poll(() => session.status).toBe("ready");
    expect(statuses).toContain("running");
    expect(statuses.at(-1)).toBe("ready");
    // C-TURN-01: readiness is real — a queued message now submits.
    await session.sendMessage("follow-up after interrupt");
    expect(ptys[0]!.writes.at(-1)).toContain("follow-up after interrupt");
  });
});
