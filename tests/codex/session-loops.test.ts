/** Codex recurring-loop parity tests (PRD §5.9, C-LOOP-01/02/12/16). */

import { afterEach, describe, expect, test } from "vitest";
import type { ElwoodLoopEvent } from "../../src/index.ts";
import { resumeCodex, startCodex } from "../../src/index.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("CodexSessionApi recurring loops", () => {
  test("C-LOOP-01/02/16 manages loops without intercepting literal slash text", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    const events: ElwoodLoopEvent[] = [];
    session.on("loop", (event) => events.push(event));
    const loop = await session.createLoop({ mode: "idle", message: "check status" });
    expect(await session.listLoops()).toEqual([loop]);

    const sent = session.sendMessage("/loop 5m remains literal");
    await becomeReady(session.elwoodSessionId, cwd);
    await sent;
    expect(ptys[0]!.writes.join("")).toContain("/loop 5m remains literal");
    expect(await session.listLoops()).toHaveLength(1);
    await session.cancelLoop(loop.id);
    expect(await session.listLoops()).toEqual([]);
    const { message, ...redactedSnapshot } = loop;
    expect(message).toBe("check status");
    expect(events).toEqual([
      {
        kind: "created",
        loopId: loop.id,
        at: loop.createdAt,
        snapshot: redactedSnapshot,
      },
      {
        kind: "cancelled",
        loopId: loop.id,
        at: expect.any(Number),
        reason: "caller",
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("check status");
  });

  test("C-LOOP-12 resume preserves identity and starts from waiting", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    const loop = await session.createLoop({ mode: "fixed", intervalMs: 60_000, message: "tick" });
    await becomeReady(session.elwoodSessionId, cwd, { session_id: "codex-resume" });
    await session.stop();

    const resumed = await resumeCodex({ cwd, elwoodSessionId: session.elwoodSessionId });
    expect(await resumed.listLoops()).toEqual([
      expect.objectContaining({ id: loop.id, jitterMs: loop.jitterMs, state: "waiting" }),
    ]);
    await resumed.teardown();
  });
});
