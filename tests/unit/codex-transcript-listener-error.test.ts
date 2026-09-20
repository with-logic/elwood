/** Codex public listener isolation with real transcript reads (PRD §5.7, C-CODEX-20). */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createCodexTranscriptWatcher } from "../../src/codex/session/transcript.ts";
import type { CodexEventMap } from "../../src/codex/session/types.ts";
import type { ElwoodActivityEvent } from "../../src/core/activity/index.ts";
import type { ElwoodWarningEvent } from "../../src/core/types.ts";
import { emitSessionWarnings } from "../../src/core/warnings/session.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";
import { tempDirForUnit } from "./helpers.ts";

afterEach(() => vi.useRealTimers());

const first = { type: "response_item", payload: { type: "reasoning", turn_id: "first" } };
const second = { type: "response_item", payload: { type: "reasoning", turn_id: "second" } };
const rejected = {
  type: "event_msg",
  payload: { type: "task_complete", turn_id: "turn-2", error: { message: "provider rejected" } },
};

const final = {
  type: "event_msg",
  payload: { type: "task_complete", turn_id: "final", error: "last" },
};

const cases = [
  { channel: "codex:transcript", warningThrows: false },
  { channel: "activity", warningThrows: false },
  { channel: "codex:transcript", warningThrows: true },
  { channel: "activity", warningThrows: true },
] as const;

test.each(
  cases,
)("C-CODEX-20 continues after $channel throws (warning throws: $warningThrows)", async ({
  channel,
  warningThrows,
}) => {
  vi.useFakeTimers();
  const emitter = new TypedEmitter<CodexEventMap>();
  const raw: unknown[] = [];
  const activities: ElwoodActivityEvent[] = [];
  const warnings: ElwoodWarningEvent[] = [];
  emitter.on(channel, () => {
    throw new Error("private listener content");
  });
  if (warningThrows)
    emitter.on("warning", () => {
      throw new Error("private warning content");
    });
  emitter.on("codex:transcript", (event) => raw.push(event.item));
  emitter.on("activity", (event) => activities.push(event));
  emitter.on("warning", (event) => warnings.push(event));
  const sink = {
    emitWarnings: (batch: readonly ElwoodWarningEvent[]) =>
      emitSessionWarnings(batch, {
        warning: (event) => emitter.emit("warning", event),
        activity: (event) => emitter.emit("activity", event),
      }),
  };
  const { watcher } = createCodexTranscriptWatcher("s1", emitter, () => sink);
  const path = join(tempDirForUnit(), "rollout.jsonl");
  writeFileSync(path, "");
  watcher.observe(path);
  try {
    appendFileSync(path, `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);
    await vi.advanceTimersByTimeAsync(250);
    expect.soft(raw).toEqual([first, second]);
    expect.soft(activities.filter((event) => event.source === "transcript")).toHaveLength(2);
    appendFileSync(path, `${JSON.stringify(rejected)}\n`);
    await vi.advanceTimersByTimeAsync(250);
    expect(raw).toEqual([first, second, rejected]);
    expect(activities.filter((event) => event.source === "transcript").at(-1)).toMatchObject({
      agent: "codex",
      source: "transcript",
      turnId: "turn-2",
      label: "task_complete",
      raw: rejected,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings).toEqual(
      Array.from({ length: 1 }, () =>
        expect.objectContaining({
          code: "transcript_listener_error",
          agent: "codex",
          channel,
        }),
      ),
    );
    expect(JSON.stringify(warnings)).not.toMatch(/private|provider rejected|turn-2/);
    expect(activities.filter((event) => event.kind === "warning")).toHaveLength(1);
    appendFileSync(path, `${JSON.stringify(final)}\n`);
    expect(() => watcher.finish()).not.toThrow();
    expect(raw).toEqual([first, second, rejected, final]);
    expect(
      activities.filter((event) => event.source === "transcript").map((event) => event.raw),
    ).toEqual([first, second, rejected, final]);
    expect(warnings.map((event) => event.code)).toEqual(["transcript_listener_error"]);
  } finally {
    watcher.finish();
  }
  expect(vi.getTimerCount()).toBe(0);
});
