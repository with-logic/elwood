/** Destructive shutdown preserves cancellation events for formerly live loops (C-LOOP-19). */
import { afterEach, expect, test } from "vitest";
import { type ElwoodLoopEvent, startClaude, startCodex } from "../../src/index.ts";
import { setGroupKillerForTests } from "../../src/runtime/shutdown/reap-tree.ts";
import * as claude from "../claude/helpers.ts";
import * as codex from "../codex/helpers.ts";

afterEach(() => {
  claude.resetFakes();
  codex.resetFakes();
});

for (const adapter of [
  { name: "claude", start: startClaude, helpers: claude },
  { name: "codex", start: startCodex, helpers: codex },
] as const) {
  for (const stopped of [false, true]) {
    test.each([
      "kill",
      "teardown",
    ] as const)(`C-LOOP-19 ${adapter.name} %s cancels only live definitions (already stopped: ${stopped})`, async (verb) => {
      adapter.helpers.installFakes();
      const session = await adapter.start({ cwd: adapter.helpers.tempDir() });
      try {
        const loop = await session.createLoop({
          mode: "fixed",
          intervalMs: 60_000,
          message: "private",
        });
        const events: ElwoodLoopEvent[] = [];
        const onLoop: (event: "loop", handler: (event: ElwoodLoopEvent) => void) => unknown =
          session.on.bind(session);
        onLoop("loop", (event) => events.push(event));
        if (stopped) await session.stop();
        await session[verb]();
        expect(events).toEqual(
          stopped
            ? []
            : [{ kind: "cancelled", loopId: loop.id, at: expect.any(Number), reason: verb }],
        );
        expect(await session.listLoops()).toEqual([]);
        await session[verb]();
        expect(events).toHaveLength(stopped ? 0 : 1);
      } finally {
        await session.teardown();
      }
    });
  }
  test(`C-LOOP-19 ${adapter.name} failed kill retains notification eligibility for its retry`, async () => {
    adapter.helpers.installFakes();
    let fail = true;
    setGroupKillerForTests({
      killGroup: () => {
        if (fail) throw new Error("reap denied");
      },
    });
    const session = await adapter.start({ cwd: adapter.helpers.tempDir() });
    try {
      const loop = await session.createLoop({ mode: "idle", message: "private" });
      const events: ElwoodLoopEvent[] = [];
      const onLoop: (event: "loop", handler: (event: ElwoodLoopEvent) => void) => unknown =
        session.on.bind(session);
      onLoop("loop", (event) => events.push(event));
      await expect(session.kill()).rejects.toMatchObject({ code: "termination_failed" });
      expect(events).toEqual([]);
      expect(await session.listLoops()).toContainEqual(expect.objectContaining({ id: loop.id }));
      fail = false;
      await session.kill();
      expect(events).toEqual([
        { kind: "cancelled", loopId: loop.id, at: expect.any(Number), reason: "kill" },
      ]);
    } finally {
      fail = false;
      await session.teardown();
    }
  });
}
