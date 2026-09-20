/** Hook-scoped initial readiness preserves queue release and telemetry (C-HOOK-22).
 * Unscoped fallback remains covered by unit/initial-ready-advance.test.ts. */

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

describe("Claude hook-scoped initial readiness (C-HOOK-22)", () => {
  test("C-HOOK-22 a throwing ready-status listener still releases the queue and warns", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    const queued = session.sendMessage("hello");
    // Scoped capture lets the ready transition complete, including queue release
    // and derived activity. The hook boundary reports one content-free failure.
    const warnings: { code: string; raw: string }[] = [];
    session.on("warning", (w) => warnings.push(w));
    session.on("status", (event) => {
      if (event.status === "ready") throw new Error("rogue status listener");
    });
    await reachReady(cwd, session.elwoodSessionId);
    await queued;
    // Anti-starvation: the queued message was released despite the throw.
    expect(ptys[0]!.writes[0]).toBe(PASTE);
    expect(warnings.map((warning) => warning.code)).toEqual(["hook_observer_failed"]);
    const warning = warnings[0];
    expect(warning).toMatchObject({
      code: "hook_observer_failed",
      agent: "claude",
      source: "lifecycle",
    });
    expect(warning?.raw).toBe("hook_observer_failed phase=lifecycle");
    // The reason field was removed: there is no persist step, only a listener throw.
    expect(warning).not.toHaveProperty("reason");
  });

  test("C-HOOK-22 a throwing WARNING sink during hook diagnostic delivery cannot re-starve the queue", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    const queued = session.sendMessage("hello");
    session.on("status", (event) => {
      if (event.status === "ready") throw new Error("rogue status listener");
    });
    // A second rogue listener throws while DELIVERING the hook warning; the
    // queue release already happened first, so the message is never starved.
    session.on("warning", () => {
      throw new Error("rogue warning sink");
    });
    await reachReady(cwd, session.elwoodSessionId);
    await queued;
    expect(ptys[0]!.writes[0]).toBe(PASTE);
  });
});
