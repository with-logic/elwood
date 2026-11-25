/** Contain rejected Codex turn-failure subscribers during live polling (C-API-65). */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createCodexTranscriptWatcher } from "../../src/codex/session/transcript.ts";
import type { CodexEventMap } from "../../src/codex/session/types.ts";
import type { ElwoodWarningEvent } from "../../src/core/types.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";
import { tempDirForUnit } from "./helpers.ts";

afterEach(() => vi.useRealTimers());

test("C-API-65 contains an asynchronous listener rejection confined to turn_failure", async () => {
  vi.useFakeTimers();
  const emitter = new TypedEmitter<CodexEventMap>();
  const raw: unknown[] = [];
  const failedTurnIds: string[] = [];
  const warnings: ElwoodWarningEvent[] = [];
  emitter.on("activity", async (event) => {
    if (event.kind !== "turn_failure") return;
    await Promise.resolve();
    throw new Error("private synthetic observer failure");
  });
  emitter.on("activity", (event) => {
    if (event.kind === "turn_failure" && event.agent === "codex") failedTurnIds.push(event.turnId);
  });
  emitter.on("codex:transcript", (event) => raw.push(event.item));
  const path = join(tempDirForUnit(), "rollout.jsonl");
  writeFileSync(path, "");
  const { watcher } = createCodexTranscriptWatcher("s1", emitter, () => ({
    emitWarnings: (batch) => warnings.push(...batch),
  }));
  watcher.observe(path);
  try {
    const rejected = {
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "t1", error: { message: "provider rejected" } },
    };
    appendFileSync(path, `${JSON.stringify(rejected)}\n`);
    await vi.advanceTimersByTimeAsync(250);
    const secondFailure = { ...rejected, payload: { ...rejected.payload, turn_id: "t2" } };
    const later = { type: "event_msg", payload: { type: "task_complete", turn_id: "t3" } };
    appendFileSync(path, `${JSON.stringify(secondFailure)}\n${JSON.stringify(later)}\n`);
    await vi.advanceTimersByTimeAsync(250);
    expect(raw).toEqual([rejected, secondFailure, later]);
    expect(failedTurnIds).toEqual(["t1", "t2"]);
    expect(warnings).toMatchObject([{ code: "transcript_listener_error", channel: "activity" }]);
    expect(JSON.stringify(warnings)).not.toMatch(/private synthetic|provider rejected/);
  } finally {
    watcher.finish();
  }
});
