/** Reentrant Claude transcript delivery precedes terminal events (PRD §5.3, C-API-20). */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test.each([
  false,
  true,
])("C-API-20 transcript stop preserves records (final flush: %s)", async (finalFlush) => {
  installFakes();
  const cwd = tempDir();
  const path = join(cwd, "transcript.jsonl");
  writeFileSync(path, "");
  const session = await startClaude({ cwd });
  const order: unknown[] = [];
  const records = ["first", "second"].map((text) => ({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  }));
  let stopped: Promise<void> | undefined;
  session.on("activity", (event) => {
    if (event.source === "transcript") stopped ??= session.stop();
  });
  session.on("activity", (event) => {
    if (event.source === "transcript") order.push(event.raw);
  });
  session.on("terminal:exit", () => order.push("exit"));
  session.on("status", (event) => {
    if (["stopped", "exited"].includes(event.status)) order.push("status");
  });
  try {
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "Stop",
      session_id: "claude-1",
      cwd,
      transcript_path: path,
    });
    for (const record of records) appendFileSync(path, `${JSON.stringify(record)}\n`);
    if (finalFlush) ptys[0]!.emitExit({ exitCode: 0 });
    await expect.poll(() => order.includes("exit")).toBe(true);
    expect(stopped).toBeDefined();
    await expect(stopped).resolves.toBeUndefined();
    expect(order).toEqual([...records, "exit", "status"]);
  } finally {
    await session.stop();
  }
});
