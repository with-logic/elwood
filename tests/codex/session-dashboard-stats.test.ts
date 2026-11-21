/** Project stats before delivering the mutable native record to subscribers (C-STATS-01). */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { CodexSession, startCodex } from "../../src/index.ts";
import { becomeReady, installFakes, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test("C-STATS-01/04 raw listeners cannot change normalized usage or snapshots", async () => {
  installFakes();
  const cwd = tempDir();
  const path = join(cwd, "rollout.jsonl");
  writeFileSync(path, "");
  const facade = new CodexSession({ cwd });
  const session = await facade.start();
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
      timestamp: "1970-01-01T00:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9 } },
        rate_limits: {
          limit_id: "codex",
          primary: { used_percent: 9, window_minutes: 300, resets_at: 1800000000 },
          secondary: { used_percent: 13, window_minutes: 10080 },
        },
      },
    };
    appendFileSync(path, `${JSON.stringify(record)}\n`);
    expect(await usage.promise).toEqual({
      scope: "thread",
      total: { inputTokens: 7, outputTokens: 2, totalTokens: 9 },
    });
    expect(order).toEqual(["raw", "activity"]);
    expect(await facade.getStats()).toMatchObject({
      latestTokenUsage: {
        transcriptPath: path,
        usage: { scope: "thread", total: { totalTokens: 9 } },
      },
      quota: {
        state: "stale",
        observedAt: record.timestamp,
        windows: [
          { label: "5-hour (codex)", usedPercent: 9, remainingPercent: 91 },
          { label: "Weekly (codex)", usedPercent: 13, remainingPercent: 87 },
        ],
      },
    });

    const emitQuota = async (rate_limits: object, timestamp?: string) => {
      const observed = session.waitForActivity((event) => event.rateLimits !== undefined);
      appendFileSync(
        path,
        `${JSON.stringify({
          type: "event_msg",
          timestamp,
          payload: { type: "token_count", rate_limits },
        })}\n`,
      );
      await observed;
    };
    await emitQuota({ secondary: { used_percent: 15 } });
    await emitQuota({ primary: { used_percent: 99 } }, record.timestamp);
    expect((await session.getStats()).quota).toMatchObject({
      state: "fresh",
      windows: [{ label: "secondary", usedPercent: 15 }],
    });
    const final = await session.getStats();
    await session.stop();
    expect(await session.getStats()).toMatchObject({
      latestTokenUsage: final.latestTokenUsage,
      quota: final.quota,
    });
  } finally {
    await session.stop();
  }
});

test("C-STATS-04 future quota does not pin a Codex snapshot or extend it past reset", async () => {
  installFakes();
  const cwd = tempDir();
  const path = join(cwd, "rollout.jsonl");
  writeFileSync(path, "");
  const session = await startCodex({ cwd });
  const received = Date.UTC(2026, 10, 20);
  const reset = received + 60_000;
  const clock = vi.spyOn(Date, "now").mockReturnValue(received);
  const emit = async (used_percent: number, timestamp: string, window_minutes: number) => {
    const next = session.waitForActivity((event) => event.rateLimits !== undefined);
    const primary = { used_percent, window_minutes, resets_at: reset / 1000 };
    appendFileSync(
      path,
      `${JSON.stringify({
        timestamp,
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: { primary },
        },
      })}\n`,
    );
    await next;
  };
  try {
    await becomeReady(session.elwoodSessionId, cwd, { transcript_path: path });
    await emit(90, "2035-01-01T00:00:00Z", 0);
    const snapshot = (await session.getStats()).quota;
    expect(snapshot).toMatchObject({
      state: "fresh",
      observedAt: new Date(received).toISOString(),
    });
    if (snapshot.state === "unavailable") throw new Error("missing transcript quota");
    expect(snapshot.windows[0]).not.toHaveProperty("windowMinutes");
    clock.mockReturnValue(received + 1000);
    await emit(25, new Date(received + 1000).toISOString(), 300);
    clock.mockReturnValue(reset - 1);
    expect((await session.getStats()).quota).toMatchObject({
      state: "fresh",
      windows: [
        {
          usedPercent: 25,
          resetsAt: new Date(reset).toISOString(),
          windowMinutes: 300,
        },
      ],
    });
    clock.mockReturnValue(reset);
    expect((await session.getStats()).quota.state).toBe("stale");
  } finally {
    clock.mockRestore();
    await session.stop();
  }
});
