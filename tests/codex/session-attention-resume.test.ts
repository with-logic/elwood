/** Working attention clearance must preserve the resumed turn's end edge (C-ATTN-02). */
import { afterEach, expect, test } from "vitest";
import { resumeCodex, startCodex } from "../../src/index.ts";
import { codexComposer, codexTty } from "../fixtures/trust-composer.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);
const frame = (text: string) => `\u001b[2J\u001b[H${text}`;

test.each([
  false,
  true,
])("C-ATTN-02 resumed clearance ends at idle with stale interrupt=%s", async (staleInterrupt) => {
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
  try {
    ptys[1]!.emitData(frame("› "));
    await session.terminal.settled();
    expect(session.status).toBe("ready");
    ptys[1]!.emitData(
      frame(
        "Would you like to run the following command?\r\n› 1. Yes\r\nPress enter to confirm or esc to cancel",
      ),
    );
    await session.terminal.settled();
    expect(session.status).toBe("blocked");
    const queued = session.sendMessage("after resumed work");
    void queued.catch(() => undefined);
    ptys[1]!.emitData(
      frame(
        "• Working (3s • esc to interrupt)\r\n› " +
          (staleInterrupt ? "\r\nConversation interrupted" : ""),
      ),
    );
    await session.terminal.settled();
    expect(session.status).toBe("running");
    expect(ptys[1]!.writes).toEqual([]);
    ptys[1]!.emitData(frame(codexTty(codexComposer)));
    await session.terminal.settled();
    await expect.poll(() => ptys[1]!.writes.join("")).toContain("after resumed work");
    await queued;
  } finally {
    await session.stop();
  }
});
