/** Observe definitive Claude rejection independently of caller submission (C-API-65). */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ClaudeSession, type ElwoodActivityEvent, startClaude } from "../../src/index.ts";
import { claudeIdle, claudeWorking } from "../fixtures/owned-turn/composer.ts";
import { nativeHooks } from "../fixtures/owned-turn/session.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test.each([
  "eager",
  "lazy",
])("C-API-65 publishes a native Claude failure before the next observed ready (%s)", async (surface) => {
  installFakes();
  const cwd = tempDir();
  const transcriptPath = join(cwd, "transcript.jsonl");
  writeFileSync(transcriptPath, "");
  const events = surface === "lazy" ? new ClaudeSession({ cwd }) : await startClaude({ cwd });
  const order: string[] = [];
  const failures: ElwoodActivityEvent[] = [];
  events.on("hook", (event) => {
    if (event.hook_event_name === "StopFailure") order.push("raw");
  });
  events.on("activity", (event) => {
    if (event.kind === "hook" && event.label === "StopFailure") order.push("hook activity");
    if (event.kind === "turn_failure") {
      order.push("failure");
      failures.push(event);
    }
  });
  events.on("status", ({ status }) => order.push(status));
  try {
    const session = events instanceof ClaudeSession ? await events.start() : events;
    const pty = ptys[0]!;
    const hooks = nativeHooks("claude", session, cwd, pty);
    await hooks.ready();
    pty.emitData(claudeWorking);
    await expect.poll(() => session.status).toBe("running");
    order.length = 0;
    const diagnostic = "The service rejected the configured model.";
    await hooks.hook({
      hook_event_name: "StopFailure",
      prompt_id: "claude-prior",
      error: "model_not_found",
      error_details: diagnostic,
      transcript_path: transcriptPath,
      last_assistant_message: "This is not the diagnostic.",
    });
    pty.emitData(claudeIdle);
    await expect.poll(() => session.status).toBe("ready");
    expect(order).toEqual(["raw", "hook activity", "failure", "ready"]);
    expect(failures).toMatchObject([
      {
        agent: "claude",
        source: "hook",
        turnId: "claude-prior",
        transcriptPath,
        label: "model_unavailable",
        turnFailure: { category: "model_unavailable", message: diagnostic, disposition: "final" },
      },
    ]);
    await hooks.hook({
      hook_event_name: "StopFailure",
      prompt_id: "older-claude-turn",
      error: "rate_limit",
      error_details: { error: { code: "usage_limit_reached", resets_at: 1_800_000_000 } },
      last_assistant_message: "The user wrote that we will be retrying.",
    });
    expect(order).toEqual([
      "raw",
      "hook activity",
      "failure",
      "ready",
      "raw",
      "hook activity",
      "failure",
    ]);
    expect(failures.at(-1)).toMatchObject({
      turnId: "older-claude-turn",
      turnFailure: {
        category: "usage_limit",
        message: "Claude rejected the turn: rate_limit",
        disposition: "final",
        resetsAtUnixSeconds: 1_800_000_000,
      },
    });
    expect(failures.at(-1)).not.toHaveProperty("transcriptPath");
    expect(session.status).toBe("ready");
  } finally {
    await events.teardown();
  }
});
