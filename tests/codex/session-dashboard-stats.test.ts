/** Project stats before delivering the mutable native record to subscribers (C-STATS-01). */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { startCodex } from "../../src/index.ts";
import { becomeReady, installFakes, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test("C-STATS-01 raw Codex transcript listeners cannot change normalized usage", async () => {
  installFakes();
  const cwd = tempDir();
  const path = join(cwd, "rollout.jsonl");
  writeFileSync(path, "");
  const session = await startCodex({ cwd });
  const order: string[] = [];
  const usage = Promise.withResolvers<unknown>();
  try {
    session.on("codex:transcript", ({ item }) => {
      order.push("raw");
      Object.assign(item as object, { payload: { type: "token_count" } });
    });
    session.on("activity", (event) => {
      if (event.source !== "transcript") return;
      order.push("activity");
      usage.resolve(event.tokenUsage);
    });
    await becomeReady(session.elwoodSessionId, cwd, { transcript_path: path });
    const record = {
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9 } },
      },
    };
    appendFileSync(path, `${JSON.stringify(record)}\n`);
    expect(await usage.promise).toEqual({
      scope: "thread",
      total: { inputTokens: 7, outputTokens: 2, totalTokens: 9 },
    });
    expect(order).toEqual(["raw", "activity"]);
  } finally {
    await session.stop();
  }
});
