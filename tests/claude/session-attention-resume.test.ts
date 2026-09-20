/** Working attention clearance must preserve the resumed turn's end edge (C-ATTN-02). */
import { afterEach, expect, test } from "vitest";
import { resumeClaude, startClaude } from "../../src/index.ts";
import { claudeComposer, tty } from "../fixtures/trust-composer.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);
const frame = (text: string) => `\u001b[2J\u001b[H${text}`;

test.each([
  false,
  true,
])("C-ATTN-02 resumed clearance ends at idle with stale interrupt=%s", async (staleInterrupt) => {
  installFakes();
  const cwd = tempDir();
  const original = await startClaude({ cwd });
  await ptys[0]!.dispatchHook(original.elwoodSessionId, {
    hook_event_name: "SessionStart",
    session_id: "claude-resume",
    cwd,
    source: "startup",
    model: "fixture",
  });
  await original.stop();
  const session = await resumeClaude({ cwd, elwoodSessionId: original.elwoodSessionId });
  try {
    ptys[1]!.emitData(frame("❯ "));
    await session.terminal.settled();
    expect(session.status).toBe("ready");
    ptys[1]!.emitData(
      frame("Do you want to create elwood.txt?\r\n❯ 1. Yes\r\n  3. No\r\nEsc to cancel"),
    );
    await session.terminal.settled();
    expect(session.status).toBe("blocked");
    const queued = session.sendMessage("after resumed work");
    void queued.catch(() => undefined);
    ptys[1]!.emitData(
      frame(
        "❯ \r\n  ⏵⏵ bypass permissions on · esc to interrupt" +
          (staleInterrupt ? "\r\n⎿ Interrupted" : ""),
      ),
    );
    await session.terminal.settled();
    expect(session.status).toBe("running");
    expect(ptys[1]!.writes).toEqual([]);
    ptys[1]!.emitData(frame(tty(claudeComposer)));
    await session.terminal.settled();
    await expect.poll(() => ptys[1]!.writes.join("")).toContain("after resumed work");
    await queued;
  } finally {
    await session.stop();
  }
});
