/** Public content-free disablement diagnostics across transcript polling (PRD §7A.5). */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  type CodexTranscriptEvent,
  type ElwoodActivityEvent,
  type ElwoodWarningEvent,
  startCodex,
} from "../../src/index.ts";
import { becomeReady, installFakes, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);
test("C-QUESTION-05 budget disablement emits one content-free warning and activity", async () => {
  installFakes();
  const cwd = tempDir();
  const path = join(cwd, "transcript.jsonl");
  writeFileSync(path, "");
  const session = await startCodex({ cwd });
  try {
    await becomeReady(session.elwoodSessionId, cwd, { transcript_path: path });
    const warnings: ElwoodWarningEvent[] = [];
    const activities: ElwoodActivityEvent[] = [];
    const transcripts: CodexTranscriptEvent[] = [];
    session.on("warning", (event) => warnings.push(event));
    session.on("activity", (event) => activities.push(event));
    session.on("codex:transcript", (event) => transcripts.push(event));
    const append = (id: string) =>
      appendFileSync(
        path,
        `${JSON.stringify({
          payload: {
            type: "message",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: "PRIVATE_QUESTION_CONTENT" }],
            id,
            delivery: "async",
            questions: Array.from({ length: 257 }, () => ({ title: "PRIVATE_QUESTION_CONTENT" })),
          },
        })}\n`,
      );
    append("budget-overflow");
    await expect
      .poll(() => warnings.filter((event) => event.code === "question_automation_disabled"))
      .toHaveLength(1);
    append("after-disable");
    await expect
      .poll(() => activities.filter((event) => event.source === "transcript"))
      .toHaveLength(2);
    const diagnostics = warnings.filter((event) => event.code === "question_automation_disabled");
    expect(diagnostics).toHaveLength(1);
    const warningActivities = activities.filter(
      (event) => event.kind === "warning" && event.label === "question_automation_disabled",
    );
    expect(warningActivities).toHaveLength(1);
    expect(JSON.stringify(warningActivities)).not.toContain("PRIVATE_QUESTION_CONTENT");
    expect(transcripts).toHaveLength(2);
    for (const event of transcripts) {
      expect(event.item).toMatchObject({
        payload: {
          role: "assistant",
          delivery: "async",
          phase: "final_answer",
          questions: expect.any(Array),
        },
      });
      expect(event.summary).toEqual({ kind: "other", label: "question" });
    }
    expect(activities.filter((event) => event.source === "transcript")).toEqual([
      expect.objectContaining({ kind: "other", label: "question" }),
      expect.objectContaining({ kind: "other", label: "question" }),
    ]);
    expect(activities.some((event) => event.kind === "assistant_message")).toBe(false);
    expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE_QUESTION_CONTENT");
    expect(await session.listQuestions()).toEqual([]);
  } finally {
    await session.kill();
  }
});
