/** Public native question discovery and bounded diagnostics (C-QUESTION-01/05). */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { type ElwoodQuestionEvent, type ElwoodWarningEvent, startCodex } from "../../src/index.ts";
import { captured, records } from "../unit/codex-questions/helpers.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);
async function setup() {
  installFakes();
  const cwd = tempDir();
  const path = join(cwd, "transcript.jsonl");
  writeFileSync(path, "");
  return { cwd, path, session: await startCodex({ cwd, initialSize: { cols: 140, rows: 45 } }) };
}

test("C-QUESTION-01 discovery exposes immutable events and snapshots without releasing ordinary input", async () => {
  const { session, path, cwd } = await setup();
  try {
    await becomeReady(session.elwoodSessionId, cwd, { transcript_path: path });
    const events: ElwoodQuestionEvent[] = [];
    const activities: ElwoodQuestionEvent[] = [];
    session.on("activity", (event) => {
      if (event.kind === "question") {
        expect(event.source).toBe("terminal");
        activities.push(event.question);
      }
    });
    session.on("question", (event) => events.push(event));
    const native = records("async-records.json");
    for (const item of native.slice(0, 3)) appendFileSync(path, `${JSON.stringify(item)}\n`);
    const panel = captured("async-badge.txt").text;
    const badge = `${panel.slice(panel.lastIndexOf("• Queued follow-up inputs")).trimEnd()}\n› Ask Codex to do anything`;
    ptys[0]!.emitData(`\x1b[2J\x1b[H${badge.replaceAll("\n", "\r\n")}`);
    await expect.poll(() => session.listQuestions()).toHaveLength(2);
    const requests = await session.listQuestions();
    expect(events.map((event) => event.request)).toEqual(requests);
    expect(Object.isFrozen(requests)).toBe(true);
    expect(Object.isFrozen(requests[0])).toBe(true);
    expect(Object.isFrozen(requests[0]!.questions)).toBe(true);
    expect(Object.isFrozen(requests[0]!.questions[0]!.options)).toBe(true);
    expect(requests[0]!.questions[0]!.supportsSecretInput).toBe(false);
    expect(session.status).toBe("ready");
    const ordinary = session.sendMessage("held ordinary input");
    void ordinary.catch(() => undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(ptys[0]!.writes).toEqual([]);
    expect(
      readFileSync(
        join(cwd, ".elwood", "sessions", session.elwoodSessionId, "session.json"),
        "utf8",
      ),
    ).not.toContain(requests[0]!.questions[0]!.prompt);
    for (const item of native.slice(3)) appendFileSync(path, `${JSON.stringify(item)}\n`);
    await expect.poll(() => session.listQuestions()).toEqual([]);
    expect(events.map((event) => event.phase)).toEqual(["raised", "raised", "closed", "closed"]);
    expect(activities).toEqual(events);
    expect(requests).toHaveLength(2);
  } finally {
    await session.kill();
  }
});

test("C-QUESTION-05 the session emits a content-free warning when native discovery exceeds its budget", async () => {
  const { session, path, cwd } = await setup();
  try {
    await becomeReady(session.elwoodSessionId, cwd, { transcript_path: path });
    const warnings: ElwoodWarningEvent[] = [];
    session.on("warning", (event) => warnings.push(event));
    appendFileSync(
      path,
      `${JSON.stringify({
        payload: {
          type: "AgentMessage",
          id: "overflow",
          delivery: "async",
          questions: Array.from({ length: 257 }, () => ({ title: "PRIVATE_METADATA" })),
        },
      })}\n`,
    );
    await expect
      .poll(() => warnings.map((event) => event.code))
      .toEqual(["question_automation_disabled"]);
    expect(JSON.stringify(warnings)).not.toContain("PRIVATE_METADATA");
    expect(await session.listQuestions()).toEqual([]);
  } finally {
    await session.kill();
  }
});
