/**
 * Codex resume readiness: the configured composer, never a bare composer marker or a
 * dialog caret, releases a resumed session, and a turn queued at resume drains through
 * rendered turn edges. Covers PRD §5.3, C-API-28, and C-TURN-03.
 */

import { afterEach, describe, expect, test } from "vitest";
import { resumeCodex, startCodex } from "../../src/index.ts";
import { codexComposer, codexTty } from "../fixtures/trust-composer.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

/** A configured session's composer: the marker above Codex's status footer. */
const configured = `\u001b[2J\u001b[H${codexTty(codexComposer)}`;

describe("CodexSessionApi resume readiness", () => {
  test("C-API-28 resume reaches ready on the first configured composer (no SessionStart needed)", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    await ptys[0]!.dispatchHook(session.elwoodSessionId, sessionStart(cwd, "codex-session-1"));
    await session.stop();
    // Resume, then render composer frames WITHOUT dispatching SessionStart (the CLI
    // does not re-fire it on resume). A bare composer marker is not enough: the resume
    // placeholder and an unrecognized menu's selected row carry it too. The configured
    // composer is, so the session reaches ready without waiting out the deadline.
    const resumed = await resumeCodex({ cwd, elwoodSessionId: session.elwoodSessionId });
    expect(resumed.status).not.toBe("ready"); // not ready until the composer renders
    ptys[1]!.emitData("\u001b[2J\u001b[H› "); // clear + home + composer marker
    await resumed.terminal.settled(); // flush the write -> render -> readiness chain
    await new Promise((r) => setImmediate(r));
    expect(resumed.status).not.toBe("ready");
    ptys[1]!.emitData(configured);
    await resumed.terminal.settled();
    await new Promise((r) => setImmediate(r));
    expect(resumed.status).toBe("ready");
  });

  test("C-API-28 resume does NOT mark ready on a blocking dialog whose caret looks like the composer", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    await ptys[0]!.dispatchHook(session.elwoodSessionId, sessionStart(cwd, "codex-session-1"));
    await session.stop();
    const resumed = await resumeCodex({ cwd, elwoodSessionId: session.elwoodSessionId });
    // The first resume frame is an approval DIALOG — its `›` caret is byte-identical to
    // the composer marker. Readiness must NOT latch, or a draining Enter could approve it.
    ptys[1]!.emitData(
      "\u001b[2J\u001b[HWould you like to run the following command?\r\n› 1. Yes\r\nPress enter to confirm or esc to cancel",
    );
    await resumed.terminal.settled();
    await new Promise((r) => setImmediate(r));
    expect(resumed.status).not.toBe("ready"); // waits for the dialog to clear
  });

  test("C-TURN-03 a turn queued during resume ends without Stop and the next message drains", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    await ptys[0]!.dispatchHook(session.elwoodSessionId, sessionStart(cwd, "codex-session-1"));
    await session.stop();
    const resumed = await resumeCodex({ cwd, elwoodSessionId: session.elwoodSessionId });
    const first = resumed.sendMessage("queued during resume");
    ptys[1]!.emitData(configured);
    await first;
    expect(resumed.status).toBe("running");
    // Without Stop, distinct native busy/idle frames retain the end edge and reopen the queue.
    ptys[1]!.emitData("\u001b[2J\u001b[H• Working (3s • esc to interrupt)\r\n› ");
    await resumed.terminal.settled(); // The busy and idle states are distinct observed frames.
    expect(resumed.terminal.snapshot().lines[0]).toBe("• Working (3s • esc to interrupt)");
    ptys[1]!.emitData("\u001b[2J\u001b[H› ");
    await expect.poll(() => resumed.status).toBe("ready");
    await resumed.sendMessage("second message drains");
    expect(ptys[1]!.writes.join("")).toContain("second message drains");
  });
});

function sessionStart(cwd: string, sessionId: string) {
  return {
    hook_event_name: "SessionStart",
    session_id: sessionId,
    cwd,
    model: "gpt-5.3-codex",
    source: "startup",
  };
}
