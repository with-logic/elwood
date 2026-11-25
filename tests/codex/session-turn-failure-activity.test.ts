/** Observe Codex failures from committed records, independently of assistant prose (C-API-65). */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { CodexSession, type ElwoodActivityEvent, startCodex } from "../../src/index.ts";
import { codexIdle } from "../fixtures/owned-turn/composer.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test.each([
  "eager",
  "lazy",
])("C-API-65 publishes failure after its raw Codex record and before a later ready (%s)", async (surface) => {
  installFakes();
  const cwd = tempDir();
  const transcriptPath = join(cwd, "rollout.jsonl");
  writeFileSync(transcriptPath, "");
  const events = surface === "lazy" ? new CodexSession({ cwd }) : await startCodex({ cwd });
  const order: string[] = [];
  const failures: ElwoodActivityEvent[] = [];
  events.on("codex:transcript", () => order.push("raw"));
  events.on("activity", (event) => {
    if (event.kind === "other") order.push("transcript activity");
    if (event.kind === "turn_failure") {
      order.push("failure");
      failures.push(event);
    }
  });
  events.on("status", ({ status }) => order.push(status));
  try {
    const session = events instanceof CodexSession ? await events.start() : events;
    const pty = ptys[0]!;
    await becomeReady(session.elwoodSessionId, cwd, { transcript_path: transcriptPath });
    await expect.poll(() => session.status).toBe("ready");
    pty.emitData(
      "\x1b[2J\x1b[H• Working (1s • esc to interrupt)\r\n\r\n› Ask Codex to do anything\r\n  gpt-5.3-codex high",
    );
    await expect.poll(() => session.status).toBe("running");
    order.length = 0;
    const message = JSON.stringify({
      type: "error",
      status: 429,
      error: { type: "usage_limit_reached", resets_at: 1800000000 },
    });
    appendFileSync(
      transcriptPath,
      `${JSON.stringify({
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "codex-prior",
          error: { message, codex_error_info: "usage_limit_exceeded" },
        },
      })}\n`,
    );
    await expect.poll(() => order).toEqual(["raw", "transcript activity", "failure"]);
    pty.emitData(codexIdle);
    await expect.poll(() => order).toEqual(["raw", "transcript activity", "failure", "ready"]);
    expect(failures).toMatchObject([
      {
        agent: "codex",
        source: "transcript",
        turnId: "codex-prior",
        transcriptPath,
        label: "usage_limit",
        turnFailure: {
          category: "usage_limit",
          message,
          disposition: "final",
          resetsAtUnixSeconds: 1800000000,
        },
      },
    ]);
    appendFileSync(
      transcriptPath,
      `${JSON.stringify({
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "older-codex-turn",
          error: { codex_error_info: "other" },
        },
      })}\n`,
    );
    await expect
      .poll(() => order)
      .toEqual([
        "raw",
        "transcript activity",
        "failure",
        "ready",
        "raw",
        "transcript activity",
        "failure",
      ]);
    expect(failures.at(-1)).toMatchObject({
      turnId: "older-codex-turn",
      turnFailure: {
        category: "unknown",
        message: "Codex rejected the turn: other",
        disposition: "final",
      },
    });
    expect(session.status).toBe("ready");
  } finally {
    await events.teardown();
  }
});
