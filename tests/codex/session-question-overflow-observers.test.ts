/** Public overflow diagnostics contain observer failures without releasing native ownership (PRD §7A.5). */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, test } from "vitest";
import { type ElwoodActivityEvent, type ElwoodWarningEvent, startCodex } from "../../src/index.ts";
import { codexComposer, codexTty } from "../fixtures/trust-composer.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);
const privateContent = "PRIVATE_OVERFLOW_PROMPT_AND_LISTENER_ERROR";

test.each([
  ["warning", "throw"],
  ["warning", "reject"],
  ["activity", "throw"],
  ["activity", "reject"],
] as const)("C-QUESTION-05 public overflow %s %s preserves both diagnostics and the native hold", async (channel, mode) => {
  installFakes();
  const cwd = tempDir();
  const path = join(cwd, "transcript.jsonl");
  writeFileSync(path, "");
  const session = await startCodex({ cwd, initialSize: { cols: 140, rows: 45 } });
  let ordinary: Promise<void> | undefined;
  try {
    await becomeReady(session.elwoodSessionId, cwd, { transcript_path: path });
    ptys[0]!.emitData(`\x1b[2J\x1b[H${codexTty(codexComposer)}`);
    await session.terminal.settled();
    expect(session.status).toBe("ready");
    const fail = () => {
      if (mode === "reject") return Promise.reject(new Error(privateContent));
      throw new Error(privateContent);
    };
    if (channel === "warning")
      session.on("warning", (event) =>
        event.code === "question_automation_disabled" ? fail() : undefined,
      );
    else
      session.on("activity", (event) =>
        event.kind === "warning" && event.label === "question_automation_disabled"
          ? fail()
          : undefined,
      );
    const warnings: ElwoodWarningEvent[] = [];
    const activities: ElwoodActivityEvent[] = [];
    session.on("warning", (event) => warnings.push(event));
    session.on("activity", (event) => {
      if (event.kind === "warning") activities.push(event);
    });
    appendFileSync(
      path,
      `${JSON.stringify({
        payload: {
          type: "AgentMessage",
          id: "overflow",
          delivery: "async",
          questions: Array.from({ length: 257 }, () => ({ title: privateContent })),
        },
      })}\n`,
    );
    await expect
      .poll(() => warnings.map((event) => event.code))
      .toEqual(["question_automation_disabled"]);
    await setImmediate();
    expect(activities.map((event) => event.label)).toEqual(["question_automation_disabled"]);
    expect(activities[0]?.raw).toBe(warnings[0]);
    expect(JSON.stringify([warnings, activities])).not.toContain(privateContent);
    expect(await session.listQuestions()).toEqual([]);
    const before = [...ptys[0]!.writes];
    let settled = false;
    ordinary = session.sendMessage("held ordinary input");
    void ordinary.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await setImmediate();
    expect(settled).toBe(false);
    expect(ptys[0]!.writes).toEqual(before);
    expect(warnings.map((event) => event.code)).toEqual(["question_automation_disabled"]);
  } finally {
    await session.kill();
    await ordinary?.catch(() => undefined);
  }
});
