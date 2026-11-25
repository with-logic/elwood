/** Observe native Codex quota rejections through public session events (C-API-69). */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { type ElwoodActivityEvent, type ElwoodWarningEvent, startCodex } from "../../src/index.ts";
import { becomeReady, installFakes, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

function tokenCount(rate_limits: object): string {
  return `${JSON.stringify({
    type: "event_msg",
    payload: { type: "token_count", rate_limits },
  })}\n`;
}

test("C-API-69 publishes structured Codex quota warnings once per unchanged rejection", async () => {
  installFakes();
  const cwd = tempDir();
  const path = join(cwd, "rollout.jsonl");
  const quota = {
    limit_id: "codex",
    limit_name: "Codex",
    rate_limit_reached_type: "rate_limit_reached",
    primary: { resets_at: 1800000000 },
    secondary: { resets_at: 1800600000 },
  };
  writeFileSync(path, tokenCount(quota));
  const session = await startCodex({ cwd });
  const warnings: ElwoodWarningEvent[] = [];
  const activities: ElwoodActivityEvent[] = [];
  const order: string[] = [];
  session.on("codex:transcript", ({ item }) => {
    order.push("raw");
    Object.assign(item as object, { payload: { type: "token_count" } });
  });
  session.on("activity", (event) => {
    if (event.kind === "turn_failure") order.push("unexpected failure");
    if (event.source !== "transcript") return;
    order.push(event.label);
    activities.push(event);
  });
  session.on("warning", (event) => warnings.push(event));
  try {
    await becomeReady(session.elwoodSessionId, cwd, { transcript_path: path });
    appendFileSync(path, tokenCount({ primary: { used_percent: 100 } }));
    appendFileSync(path, tokenCount(quota).repeat(2));
    await expect.poll(() => order.filter((label) => label === "raw")).toHaveLength(3);
    expect(warnings).toEqual([
      {
        elwoodSessionId: session.elwoodSessionId,
        agent: "codex",
        source: "transcript",
        code: "usage_limit_reached",
        severity: "warning",
        message: "Codex reached its rate limit.",
        nativeLimitType: "rate_limit_reached",
        transcriptPath: path,
        limitId: "codex",
        limitName: "Codex",
        primaryResetsAtUnixSeconds: 1800000000,
        secondaryResetsAtUnixSeconds: 1800600000,
        raw: "rate_limit_reached",
      },
    ]);
    expect(order).toEqual([
      "raw",
      "token_count",
      "raw",
      "token_count",
      "usage_limit_reached",
      "raw",
      "token_count",
    ]);
    expect(activities[2]).toEqual({
      elwoodSessionId: session.elwoodSessionId,
      agent: "codex",
      source: "transcript",
      kind: "warning",
      label: "usage_limit_reached",
      text: "Codex reached its rate limit.",
      transcriptPath: path,
      raw: warnings[0],
    });
    expect((await session.getStats()).quota.windows[0]).toMatchObject({ usedPercent: 100 });
    expect(session.status).toBe("ready");
  } finally {
    await session.teardown();
  }
});
