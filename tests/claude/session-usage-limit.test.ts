/** Observe rejected Claude quota from live native transcript records (C-API-68). */
import { afterEach, expect, test } from "vitest";
import type { ElwoodWarningEvent } from "../../src/index.ts";
import { claudeIdle, claudeWorking } from "../fixtures/owned-turn/composer.ts";
import { ptys, resetFakes } from "./helpers.ts";
import { startActivitySession, user } from "./session-user-activity-helpers.ts";

afterEach(resetFakes);

const message = "You've hit your Fable limit · resets 9pm (America/Los_Angeles)";
const resetsAt = Date.parse("2026-11-25T21:00:00-08:00") / 1_000;

function rejectedQuota(uuid: string, text: string, nativeModel = "<synthetic>") {
  return {
    type: "assistant",
    uuid,
    parentUuid: "native-attachment",
    isApiErrorMessage: true,
    error: "rate_limit",
    apiError: "usage_limit_reached",
    apiErrorParams: {
      rate_limit_info: {
        status: "rejected",
        resetsAt,
        rateLimitType: "seven_day_overage_included",
      },
    },
    message: {
      model: nativeModel,
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Internal diagnostic" },
        { type: "text", text: " " },
        { type: "text", text },
        { type: "text", text: `Details for ${uuid}` },
      ],
    },
  };
}

test.each([
  false,
  true,
])("C-API-68 exposes a Fable limit independently of StopFailure (late: %s)", async (late) => {
  const { session, hook, events, append } = await startActivitySession();
  const warnings: ElwoodWarningEvent[] = [];
  const offWarning = session.on("warning", (warning) => warnings.push(warning));
  try {
    const pty = ptys.at(-1)!;
    await hook({ hook_event_name: "SessionStart", source: "startup" });
    await hook({
      hook_event_name: "InstructionsLoaded",
      file_path: "/tmp/CLAUDE.md",
      memory_type: "Project",
      load_reason: "session_start",
    });
    await hook({ hook_event_name: "UserPromptSubmit", prompt_id: "fable-turn", prompt: "example" });
    const fail = () =>
      hook({
        hook_event_name: "StopFailure",
        prompt_id: "fable-turn",
        error: "rate_limit",
        last_assistant_message: message,
      });
    pty.emitData(claudeWorking);
    await expect.poll(() => session.status).toBe("running");
    if (late) {
      await fail();
      pty.emitData(claudeIdle);
      await expect.poll(() => session.status).toBe("ready");
      expect(warnings).toEqual([]);
    }
    append(
      user("fable-turn", "example"),
      { type: "attachment", uuid: "native-attachment", parentUuid: "user-fable-turn" },
      rejectedQuota("ordinary-text", "You've hit your ordinary limit", "claude-fable-5-2"),
      {
        ...rejectedQuota("generic-throttle", "You've hit your generic limit"),
        apiError: undefined,
        apiErrorParams: undefined,
      },
      rejectedQuota("rejected-fable", message),
    );
    await expect
      .poll(() => warnings)
      .toMatchObject([
        {
          agent: "claude",
          source: "transcript",
          code: "usage_limit_reached",
          message,
          limitName: "Fable",
          nativeLimitType: "seven_day_overage_included",
          resetsAtUnixSeconds: resetsAt,
          turnId: "fable-turn",
        },
      ]);
    expect(events.filter(({ kind }) => kind === "assistant_message")).toHaveLength(9);
    expect(events.filter(({ label }) => label === "usage_limit_reached")).toMatchObject([
      {
        kind: "warning",
        source: "transcript",
        text: message,
        transcriptPath: expect.any(String),
        turnId: "fable-turn",
        raw: warnings[0],
      },
    ]);
    expect(events.some(({ kind }) => kind === "turn_failure")).toBe(late);
    expect(session.status).toBe(late ? "ready" : "running");
    if (!late) await fail();
    expect(warnings).toHaveLength(1);
    expect(events.find(({ kind }) => kind === "turn_failure")).toMatchObject({
      turnId: "fable-turn",
      turnFailure: { category: "rate_limited", disposition: "final" },
    });
  } finally {
    offWarning();
    await session.teardown();
  }
});
