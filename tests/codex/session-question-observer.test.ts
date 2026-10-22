/** Real Codex discovery preserves notification delivery after observer failure (PRD §5.4). */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  type ElwoodActivityEvent,
  type ElwoodQuestionEvent,
  type ElwoodWarningEvent,
  startCodex,
} from "../../src/index.ts";
import { captured, records } from "../unit/codex-questions/helpers.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);
test("Codex diagnoses a throwing question consumer once and continues both queued requests", async () => {
  installFakes();
  const cwd = tempDir();
  const path = join(cwd, "transcript.jsonl");
  writeFileSync(path, "");
  const session = await startCodex({ cwd, initialSize: { cols: 140, rows: 45 } });
  const privateCause = "PRIVATE_CODEX_QUESTION_OBSERVER_CAUSE";
  const questions: ElwoodQuestionEvent[] = [];
  const mirrors: ElwoodQuestionEvent[] = [];
  const warnings: ElwoodWarningEvent[] = [];
  const warningActivities: ElwoodActivityEvent[] = [];
  try {
    await becomeReady(session.elwoodSessionId, cwd, { transcript_path: path });
    session.on("question", () => {
      throw new Error(privateCause);
    });
    session.on("question", (event) => questions.push(event));
    session.on("warning", (event) => warnings.push(event));
    session.on("activity", (event) => {
      if (event.kind === "question") mirrors.push(event.question);
      if (event.kind === "warning" && event.label === "question_observer_failed")
        warningActivities.push(event);
    });
    const native = records("async-records.json");
    for (const item of native.slice(0, 3)) appendFileSync(path, `${JSON.stringify(item)}\n`);
    const panel = captured("async-badge.txt").text;
    const badge = `${panel.slice(panel.lastIndexOf("• Queued follow-up inputs")).trimEnd()}\n› Ask Codex to do anything`;
    ptys[0]!.emitData(`\x1b[2J\x1b[H${badge.replaceAll("\n", "\r\n")}`);
    await expect.poll(() => session.listQuestions()).toHaveLength(2);
    const requests = await session.listQuestions();
    expect(questions.map((event) => event.request)).toEqual(requests);
    expect(questions.map((event) => event.phase)).toEqual(["raised", "raised"]);
    for (const item of native.slice(3)) appendFileSync(path, `${JSON.stringify(item)}\n`);
    await expect.poll(() => session.listQuestions()).toEqual([]);
    expect(questions.map((event) => event.phase)).toEqual(["raised", "raised", "closed", "closed"]);
    expect(questions.slice(2).map((event) => event.request)).toEqual(requests);
    expect(questions.slice(2)).toMatchObject([{ reason: "answered" }, { reason: "answered" }]);
    expect(mirrors).toEqual(questions);
    expect(session.status).toBe("ready");
    expect(warnings).toEqual([
      {
        elwoodSessionId: session.elwoodSessionId,
        agent: "codex",
        source: "lifecycle",
        code: "question_observer_failed",
        severity: "warning",
        phase: "question",
        message: "A question notification failed; native question ownership was preserved.",
        raw: "question_observer_failed phase=question",
      },
    ]);
    expect(warningActivities).toEqual([
      {
        elwoodSessionId: session.elwoodSessionId,
        agent: "codex",
        source: "lifecycle",
        kind: "warning",
        label: "question_observer_failed",
        text: warnings[0]!.message,
        raw: warnings[0],
      },
    ]);
    const diagnostics = JSON.stringify([warnings, warningActivities]);
    expect(diagnostics).not.toContain(privateCause);
    for (const request of requests) expect(diagnostics).not.toContain(request.questions[0]!.prompt);
  } finally {
    await session.kill();
  }
});
