/** Observe native Codex quota rejections through public session events (C-API-69). */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  type ElwoodActivityEvent,
  type ElwoodWarningEvent,
  resumeCodex,
  startCodex,
} from "../../src/index.ts";
import { currentPtyFactory, setPtyFactoryForTests } from "../../src/runtime/seams.ts";
import { setStartupWaitMsForTests } from "../../src/runtime/startup/index.ts";
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
  const creditDenial = tokenCount({
    limit_id: "codex",
    rate_limit_reached_type: "workspace_owner_credits_depleted",
  });
  writeFileSync(path, creditDenial);
  const session = await startCodex({ cwd });
  const warnings: ElwoodWarningEvent[] = [];
  const activities: ElwoodActivityEvent[] = [];
  const order: string[] = [];
  session.on("codex:transcript", ({ item }) => {
    order.push("raw");
    Object.assign(item as object, { payload: { type: "token_count" } });
  });
  session.on("activity", (event) => {
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
    expect((await session.getStats()).quota).toMatchObject({ windows: [{ usedPercent: 100 }] });
    writeFileSync(path, creditDenial);
    await expect.poll(() => order.filter((label) => label === "raw")).toHaveLength(4);
    expect(warnings).toHaveLength(1);
    appendFileSync(path, creditDenial);
    await expect.poll(() => warnings).toHaveLength(2);
    expect(warnings.at(-1)).toMatchObject({ nativeLimitType: "workspace_owner_credits_depleted" });
    const message = "Your workspace is out of credits. Add credits to continue.";
    appendFileSync(
      path,
      `${JSON.stringify({
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "credit-denial-turn",
          error: { codex_error_info: "usage_limit_exceeded", message },
        },
      })}\n`,
    );
    await expect
      .poll(() => activities.find(({ kind }) => kind === "turn_failure"))
      .toMatchObject({
        turnId: "credit-denial-turn",
        turnFailure: { message, disposition: "final" },
      });
    expect(warnings).toHaveLength(2);
    expect(session.status).toBe("ready");
  } finally {
    await session.teardown();
  }
});

test("C-API-69 suppresses quota history and delivers a forward record during Codex resume", async () => {
  installFakes();
  const cwd = tempDir();
  const path = join(cwd, "rollout.jsonl");
  const nativeSessionId = "native-quota-resume";
  const history = tokenCount({ rate_limit_reached_type: "workspace_owner_credits_depleted" });
  writeFileSync(
    path,
    `${JSON.stringify({ type: "session_meta", payload: { id: nativeSessionId } })}\n${history}`,
  );
  const initial = await startCodex({ cwd });
  const { elwoodSessionId } = initial;
  try {
    await becomeReady(elwoodSessionId, cwd, { session_id: nativeSessionId, transcript_path: path });
  } finally {
    await initial.stop();
  }

  const live = tokenCount({
    limit_id: "codex",
    rate_limit_reached_type: "workspace_member_usage_limit_reached",
  });
  const factory = currentPtyFactory();
  setPtyFactoryForTests((options) => {
    appendFileSync(path, live);
    return factory(options);
  });
  // A poll started at PTY spawn could consume the live record before subscription.
  setStartupWaitMsForTests(350);
  const resumed = await resumeCodex({ cwd, elwoodSessionId });
  const warnings: ElwoodWarningEvent[] = [];
  const activities: ElwoodActivityEvent[] = [];
  const seen: unknown[] = [];
  resumed.on("codex:transcript", ({ item }) => seen.push(item));
  resumed.on("warning", (event) => {
    if (event.code === "usage_limit_reached") warnings.push(event);
  });
  resumed.on("activity", (event) => {
    if (event.label === "usage_limit_reached") activities.push(event);
  });
  try {
    await expect
      .poll(() => warnings)
      .toEqual([
        expect.objectContaining({
          agent: "codex",
          nativeLimitType: "workspace_member_usage_limit_reached",
          limitId: "codex",
          transcriptPath: path,
        }),
      ]);
    expect(seen).toEqual([JSON.parse(live)]);
    expect(activities).toEqual([expect.objectContaining({ kind: "warning", raw: warnings[0] })]);
  } finally {
    await resumed.teardown();
  }
});
