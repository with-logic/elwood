/** Transcript delivery precedes warning-triggered shutdown (PRD §5.7, C-CODEX-20). */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { startCodex } from "../../src/index.ts";
import { becomeReady, installFakes, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test("C-CODEX-20 a warning listener stopping the session preserves the current scan", async () => {
  installFakes();
  const cwd = tempDir();
  const path = join(cwd, "rollout.jsonl");
  writeFileSync(path, "");
  const session = await startCodex({ cwd });
  const order: string[] = [];
  let stopped: Promise<void> | undefined;
  session.on("codex:transcript", () => {
    throw new Error("consumer failed");
  });
  session.on("activity", (event) => {
    if (event.source === "transcript") order.push(event.turnId ?? "missing");
  });
  session.on("terminal:exit", () => order.push("exit"));
  session.on("warning", (warning) => {
    if (warning.code === "transcript_listener_error") stopped ??= session.stop();
  });
  try {
    await becomeReady(session.elwoodSessionId, cwd, { transcript_path: path });
    for (const turn_id of ["first", "second"]) {
      appendFileSync(
        path,
        `${JSON.stringify({
          type: "event_msg",
          payload: { type: "task_complete", turn_id, error: "rejected" },
        })}\n`,
      );
    }
    await expect.poll(() => order.includes("exit")).toBe(true);
    await stopped;
    expect(order).toEqual(["first", "second", "exit"]);
  } finally {
    await session.stop();
  }
});
