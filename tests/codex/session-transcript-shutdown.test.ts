/** Reentrant transcript shutdown preserves delivery before exit (PRD §5.7, C-LIFE-10). */
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
  ])(`C-LIFE-10 ${channel} stopping during transcript delivery preserves records (final flush: %s)`, async (finalFlush) => {
    installFakes();
    const cwd = tempDir();
    const path = join(cwd, "rollout.jsonl");
    writeFileSync(path, "");
    const session = await startCodex({ cwd });
    const order: unknown[] = [];
    const records = ["first", "second"].map((turn_id) => ({
      type: "event_msg",
      payload: { type: "task_complete", turn_id, error: "rejected" },
    }));
    let stopped: Promise<void> | undefined;
    session.on(channel, (event) => {
      if ("source" in event && event.source !== "transcript") return;
      stopped ??= session.stop();
    });
    session.on("codex:transcript", (event) => order.push({ raw: event.item }));
    session.on("activity", (event) => {
      if (event.source === "transcript") order.push({ activity: event.raw });
    });
    session.on("terminal:exit", () => order.push("exit"));
    try {
      await becomeReady(session.elwoodSessionId, cwd, { transcript_path: path });
      for (const record of records) appendFileSync(path, `${JSON.stringify(record)}\n`);
      if (finalFlush) ptys[0]!.emitExit({ exitCode: 0 });
      await expect.poll(() => order.includes("exit")).toBe(true);
      await stopped;
      expect(order).toEqual([
        { raw: records[0] },
        { activity: records[0] },
        { raw: records[1] },
        { activity: records[1] },
        "exit",
      ]);
    } finally {
      await session.stop();
    }
  });
}
