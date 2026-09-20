/** Every readiness source respects a deferred startup attention hold (C-API-28). */
import { afterEach, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { claudeComposer, tty } from "../fixtures/trust-composer.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);
const frame = (text: string) => `\u001b[2J\u001b[H${text}`;

test.each([
  "hook",
  "rendered",
])("C-API-28 deferred initial hold rejects late %s readiness", async (source) => {
  installFakes();
  const cwd = tempDir();
  const session = await startClaude({ cwd });
  const statuses: string[] = [];
  session.on("status", (event) => statuses.push(event.status));
  const paint = async (text: string) => {
    ptys[0]!.emitData(frame(text));
    await session.terminal.settled();
  };
  const stopHook = () =>
    ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "Stop",
      session_id: "claude-hold",
      cwd,
    });
  try {
    await paint("Do you want to create elwood.txt?\r\n❯ 1. Yes\r\n  3. No\r\nEsc to cancel");
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "InstructionsLoaded",
      file_path: "/tmp/CLAUDE.md",
      memory_type: "Project",
      load_reason: "session_start",
      session_id: "claude-hold",
      cwd,
    });
    expect(session.status).toBe("blocked");
    const queued = session.sendMessage("after verified idle");
    void queued.catch(() => undefined);
    await paint("esc to interrupt\r\n❯ ");
    expect(session.status).toBe("running");
    await paint("");
    if (source === "hook") await stopHook();
    else await paint("⎿ Interrupted");
    expect(session.status).toBe("running");
    expect(statuses).not.toContain("ready");
    expect(ptys[0]!.writes).toEqual([]);
    await paint(tty(claudeComposer));
    await queued;
    expect(statuses.filter((status) => status === "ready")).toHaveLength(1);
    expect(ptys[0]!.writes).toEqual(["\u001b[200~after verified idle\u001b[201~", "\r"]);
    await stopHook();
    expect(session.status).toBe("ready");
  } finally {
    await session.stop();
  }
});
