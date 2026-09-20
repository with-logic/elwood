/** Every readiness source respects a deferred startup attention hold (C-API-28). */
import { afterEach, expect, test } from "vitest";
import { startCodex } from "../../src/index.ts";
import { codexComposer, codexTty } from "../fixtures/trust-composer.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);
const frame = (text: string) => `\u001b[2J\u001b[H${text}`;

test.each([
  "hook",
  "rendered",
])("C-API-28 deferred initial hold rejects late %s readiness", async (source) => {
  installFakes();
  const cwd = tempDir();
  const session = await startCodex({ cwd });
  const statuses: string[] = [];
  session.on("status", (event) => statuses.push(event.status));
  const paint = async (text: string) => {
    ptys[0]!.emitData(frame(text));
    await session.terminal.settled();
  };
  const stopHook = () =>
    ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "Stop",
      session_id: "codex-hold",
      cwd,
      model: "fixture",
      turn_id: "turn-hold",
      stop_hook_active: false,
    });
  try {
    await paint(
      "Would you like to run the following command?\r\n› 1. Yes\r\nPress enter to confirm or esc to cancel",
    );
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "SessionStart",
      source: "startup",
      model: "fixture",
      session_id: "codex-hold",
      cwd,
    });
    expect(session.status).toBe("blocked");
    const queued = session.sendMessage("after verified idle");
    void queued.catch(() => undefined);
    await paint("• Working (3s • esc to interrupt)\r\n› ");
    expect(session.status).toBe("running");
    await paint("");
    if (source === "hook") await stopHook();
    else await paint("Conversation interrupted");
    expect(session.status).toBe("running");
    expect(statuses).not.toContain("ready");
    expect(ptys[0]!.writes).toEqual([]);
    await paint(codexTty(codexComposer));
    await queued;
    expect(statuses.filter((status) => status === "ready")).toHaveLength(1);
    expect(ptys[0]!.writes).toEqual(["\u001b[200~after verified idle\u001b[201~", "\r"]);
    await stopHook();
    expect(session.status).toBe("ready");
  } finally {
    await session.stop();
  }
});

test("C-API-28 a deferred initial dialog can clear directly to verified idle", async () => {
  installFakes();
  const cwd = tempDir();
  const session = await startCodex({ cwd });
  try {
    ptys[0]!.emitData(
      frame(
        "Would you like to run the following command?\r\n› 1. Yes\r\nPress enter to confirm or esc to cancel",
      ),
    );
    await session.terminal.settled();
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "SessionStart",
      source: "startup",
      model: "fixture",
      session_id: "codex-idle-clear",
      cwd,
    });
    expect(session.status).toBe("blocked");
    ptys[0]!.emitData(frame(codexTty(codexComposer)));
    await session.terminal.settled();
    expect(session.status).toBe("ready");
    await session.sendMessage("after direct idle");
    expect(ptys[0]!.writes).toEqual(["\u001b[200~after direct idle\u001b[201~", "\r"]);
  } finally {
    await session.stop();
  }
});
