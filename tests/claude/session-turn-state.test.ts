/**
 * Conformance tests for rendered-TUI turn boundaries on Claude sessions.
 * Covers PRD §5.3, C-TURN-01, and C-TURN-02.
 */

import { afterEach, describe, expect, test } from "vitest";
import { resumeClaude, startClaude } from "../../src/index.ts";
import { claudeComposer, claudeTty } from "../fixtures/trust-composer.ts";
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

const sessionStart = (cwd: string) => ({
  hook_event_name: "SessionStart",
  session_id: "claude-1",
  cwd,
  source: "startup",
});

const workingFooter = "❯ \r\n  ⏵⏵ bypass permissions · esc to interrupt · ← for agents";
const idleFooter = "❯ \r\n  ⏵⏵ bypass permissions · ← for agents";

describe("ClaudeSessionApi turn boundaries", () => {
  test("C-API-28 a resumed permission-dialog caret cannot release readiness", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await ptys[0]!.dispatchHook(session.elwoodSessionId, sessionStart(cwd));
    await session.stop();
    const resumed = await resumeClaude({ cwd, elwoodSessionId: session.elwoodSessionId });
    ptys[1]!.emitData(
      "\u001b[2J\u001b[HDo you want to run this tool?\r\n❯ 1. Yes\r\n  2. No\r\nEsc to cancel",
    );
    await resumed.terminal.settled();
    expect(resumed.status).not.toBe("ready");
    ptys[1]!.emitData(`\u001b[2J\u001b[H${claudeTty(claudeComposer)}`);
    await expect.poll(() => resumed.status).toBe("ready");
  });

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
    expect(ptys[0]!.writes.join("")).toContain("follow-up after interrupt");
  });
});

const interruptBanner46 = "  ⎿  Interrupted· What should Claude do \r\n❯ ";

describe("ClaudeSessionApi narrow-width turn boundaries", () => {
  test("C-TURN-04 the interrupt banner ends the turn when the footer is elided", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd, initialSize: { cols: 46, rows: 12 } });
    await ptys[0]!.dispatchHook(session.elwoodSessionId, instructionsLoaded(cwd));
    expect(session.status).toBe("ready");
    // The turn starts via submission; the elided footer never shows the token.
    await session.sendMessage("long persona turn");
    expect(session.status).toBe("running");
    ptys[0]!.emitData("  essay text streaming, no footer token\r\n❯ ");
    expect(session.status).toBe("running");
    // Escape: the CLI renders the Interrupted banner — that alone ends the turn.
    ptys[0]!.emitData(interruptBanner46);
    await expect.poll(() => session.status).toBe("ready");
    await session.sendMessage("follow-up after narrow interrupt");
    expect(ptys[0]!.writes.join("")).toContain("follow-up after narrow interrupt");
  });
});
