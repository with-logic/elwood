/** Observe rejected Claude quota from live native transcript records (C-API-68). */
import { afterEach, type ExpectStatic, test } from "vitest";
import type { ElwoodWarningEvent } from "../../src/index.ts";
import { claudeIdle, claudeWorking } from "../fixtures/owned-turn/composer.ts";
import { ptys, resetFakes } from "./helpers.ts";
import { startActivitySession, user } from "./session-user-activity-helpers.ts";

afterEach(resetFakes);

const message = "You've hit your Fable limit · resets 9pm (America/Los_Angeles)";
const resetsAt = Date.parse("2026-11-25T21:00:00-08:00") / 1_000;
const turnId = "fable-turn";
const ordinary = "You've hit your ordinary limit";
const generic = "You've hit your generic limit";

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

type UsageLimit = Extract<ElwoodWarningEvent, { code: "usage_limit_reached" }>;

async function withFableTurn(
  assert: ExpectStatic,
  run: (options: {
    readonly session: Awaited<ReturnType<typeof startActivitySession>>["session"];
    readonly warnings: readonly ElwoodWarningEvent[];
    readonly failures: () => readonly unknown[];
    readonly fail: () => Promise<unknown>;
    readonly returnToReady: () => Promise<void>;
    readonly appendQuota: () => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const { session, hook, events, append, transcript } = await startActivitySession();
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
    await hook({ hook_event_name: "UserPromptSubmit", prompt_id: turnId, prompt: "example" });
    pty.emitData(claudeWorking);
    await assert.poll(() => session.status).toBe("running");
    await run({
      session,
      warnings,
      failures: () => events.filter(({ kind }) => kind === "turn_failure"),
      fail: () =>
        hook({
          hook_event_name: "StopFailure",
          prompt_id: turnId,
          error: "rate_limit",
          last_assistant_message: message,
        }),
      async returnToReady() {
        pty.emitData(claudeIdle);
        await assert.poll(() => session.status).toBe("ready");
      },
      async appendQuota() {
        append(
          user(turnId, "example"),
          { type: "attachment", uuid: "native-attachment", parentUuid: "user-fable-turn" },
          rejectedQuota("ordinary-text", ordinary, "claude-fable-5-2"),
          { ...rejectedQuota("generic-throttle", generic), apiError: "rate_limit" },
          rejectedQuota("rejected-fable", message),
        );
        const expected: UsageLimit = {
          elwoodSessionId: session.elwoodSessionId,
          agent: "claude",
          source: "transcript",
          code: "usage_limit_reached",
          severity: "warning",
          message,
          limitName: "Fable",
          nativeLimitType: "seven_day_overage_included",
          resetsAtUnixSeconds: resetsAt,
          transcriptPath: transcript,
          turnId,
          raw: "usage_limit_reached",
        };
        await assert.poll(() => warnings).toEqual([expected]);
        assert(events.filter(({ label }) => label === "usage_limit_reached")).toEqual([
          {
            elwoodSessionId: session.elwoodSessionId,
            agent: "claude",
            kind: "warning",
            source: "transcript",
            label: "usage_limit_reached",
            text: message,
            transcriptPath: transcript,
            turnId,
            raw: expected,
          },
        ]);
        assert(events.filter(({ kind }) => kind === "assistant_message")).toMatchObject(
          [
            " ",
            ordinary,
            "Details for ordinary-text",
            " ",
            generic,
            "Details for generic-throttle",
            " ",
            message,
            "Details for rejected-fable",
          ].map((text) => ({ text, transcriptPath: transcript, turnId })),
        );
      },
    });
  } finally {
    offWarning();
    await session.teardown();
  }
}

const turnFailure = [{ turnId, turnFailure: { category: "rate_limited", disposition: "final" } }];

test("C-API-68 reports a committed Fable limit before a later StopFailure", ({ expect }) =>
  withFableTurn(expect, async ({ session, warnings, failures, fail, appendQuota }) => {
    await appendQuota();
    expect(failures()).toEqual([]);
    expect(session.status).toBe("running");
    await fail();
    expect(warnings).toHaveLength(1);
    expect(failures()).toMatchObject(turnFailure);
  }));

test("C-API-68 reports a Fable limit committed after the failure hook and ready", ({ expect }) =>
  withFableTurn(
    expect,
    async ({ session, warnings, failures, fail, returnToReady, appendQuota }) => {
      await fail();
      await returnToReady();
      expect(warnings).toEqual([]);
      expect(failures()).toMatchObject(turnFailure);
      await appendQuota();
      expect(failures()).toMatchObject(turnFailure);
      expect(session.status).toBe("ready");
    },
  ));
