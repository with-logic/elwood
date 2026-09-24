/** Real Codex bridge observer failures preserve Stop and error bookkeeping (C-HOOK-22). */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { startCodex } from "../../src/index.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test("C-HOOK-22 a throwing observer cannot skip unblocked Codex Stop transcript or readiness", async () => {
  installFakes();
  const cwd = tempDir();
  const transcript = join(cwd, "codex.jsonl");
  writeFileSync(transcript, "");
  const session = await startCodex({ cwd });
  const warnings: string[] = [];
  const summaries: string[] = [];
  try {
    session.on("warning", (event) =>
      warnings.push(`${event.code}:${"phase" in event ? event.phase : ""}`),
    );
    session.on("codex:transcript", (event) => summaries.push(event.summary.kind));
    session.on("hook", (event) => {
      if (event.hook_event_name === "Stop") throw new Error("private Stop observer");
    });
    await becomeReady(session.elwoodSessionId, cwd, { transcript_path: transcript });
    await session.sendPrompt("busy");
    expect(session.status).toBe("running");
    appendFileSync(
      transcript,
      `${JSON.stringify({ type: "response_item", payload: { type: "reasoning" } })}\n`,
    );
    const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "Stop",
      session_id: "codex-1",
      cwd,
      turn_id: "turn-1",
      stop_hook_active: false,
    });
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(summaries).toEqual(["reasoning"]);
    expect(session.status).toBe("ready");
    expect(warnings).toEqual(["hook_observer_failed:hook"]);
  } finally {
    await session.teardown();
  }
});

test("C-HOOK-22 the Codex bridge contains an error observer and reports a bounded warning", async () => {
  installFakes();
  const cwd = tempDir();
  const session = await startCodex({ cwd });
  const warnings: string[] = [];
  try {
    session.on("hookError", () => {
      throw new Error("private bridge observer");
    });
    session.on("warning", (event) =>
      warnings.push(`${event.code}:${"phase" in event ? event.phase : ""}`),
    );
    await ptys[0]!.dispatchMalformedHook(session.elwoodSessionId);
    expect(warnings).toEqual(["hook_observer_failed:hook_error"]);
  } finally {
    await session.teardown();
  }
});
