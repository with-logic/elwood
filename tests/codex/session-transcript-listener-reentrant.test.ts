/** Throwing reentrant consumers preserve the full scan before exit (PRD §5.7, C-CODEX-20). */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { startCodex } from "../../src/index.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

for (const channel of ["codex:transcript", "activity"] as const) {
  test.each([
    false,
    true,
  ])(`C-CODEX-20 ${channel} stop-then-throw preserves delivery (final flush: %s)`, async (finalFlush) => {
    installFakes();
    const cwd = tempDir();
    const path = join(cwd, "rollout.jsonl");
    writeFileSync(path, "");
    const session = await startCodex({ cwd });
    const records = ["first", "second"].map((turn_id) => ({
      type: "event_msg",
      payload: { type: "task_complete", turn_id, error: "rejected" },
    }));
    const order: unknown[] = [];
    const warnings: unknown[] = [];
    let stopped: Promise<void> | undefined;
    session.on(channel, (event) => {
      if ("source" in event && event.source !== "transcript") return;
      stopped ??= session.stop();
      throw new Error("private consumer failure");
    });
    session.on("codex:transcript", (event) => order.push({ raw: event.item }));
    session.on("activity", (event) => {
      if (event.source === "transcript") order.push({ activity: event.raw });
    });
    session.on("warning", (event) => {
      if (event.code === "transcript_listener_error") warnings.push(event);
    });
    session.on("terminal:exit", () => order.push("exit"));
    try {
      await becomeReady(session.elwoodSessionId, cwd, { transcript_path: path });
      for (const record of records) appendFileSync(path, `${JSON.stringify(record)}\n`);
      if (finalFlush) ptys[0]!.emitExit({ exitCode: 0 });
      await expect.poll(() => order.includes("exit")).toBe(true);
      expect(stopped).toBeDefined();
      await expect(stopped).resolves.toBeUndefined();
      await Promise.resolve();
      expect(order).toEqual([
        { raw: records[0] },
        { activity: records[0] },
        { raw: records[1] },
        { activity: records[1] },
        "exit",
      ]);
      // Deferred diagnostics may follow terminal exit; transcript delivery may not.
      expect(warnings).toEqual([
        expect.objectContaining({ code: "transcript_listener_error", channel }),
      ]);
      expect(JSON.stringify(warnings)).not.toContain("private consumer failure");
    } finally {
      await session.stop();
    }
  });
}
