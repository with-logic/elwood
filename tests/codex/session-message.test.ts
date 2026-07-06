/**
 * Conformance tests for Codex adapter-neutral queued messages.
 * Covers PRD §5.3, C-API-19, and C-API-21.
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { startCodex } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("CodexSession message submission", () => {
  test("C-API-19 first sendMessage waits for first rendered terminal frame", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    const queued = session.sendMessage("hello");
    expect(ptys[0]!.writes).toEqual([]);
    ptys[0]!.emitData("codex rendered\r\n\u203a ");
    await queued;
    expect(ptys[0]!.writes).toEqual(["\u001b[200~hello\u001b[201~\r"]);
    expect(session.status).toBe("running");
  });

  test("C-API-20 flushes transcript activity before terminal exit", async () => {
    const cwd = tempDir();
    const transcript = join(cwd, "codex.jsonl");
    installFakes();
    writeFileSync(transcript, "");
    const session = await startCodex({ cwd });
    const order: string[] = [];
    session.on("activity", (event) => {
      if (event.source === "transcript" && event.kind === "assistant_message") order.push("tx");
      if (event.kind === "terminal_exit") order.push("exit");
      if (event.kind === "status" && event.status === "exited") order.push("exited");
    });
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "SessionStart",
      session_id: "codex-1",
      transcript_path: transcript,
      cwd,
      model: "gpt-5.3-codex",
      source: "startup",
    });
    appendFileSync(transcript, `${JSON.stringify(item("agent_message", { message: "done" }))}\n`);
    ptys[0]!.emitExit({ exitCode: 0 });
    expect(order).toEqual(["tx", "exit", "exited"]);
  });

  test("C-API-20 flushes transcript activity before Stop readiness", async () => {
    const cwd = tempDir();
    const transcript = join(cwd, "codex.jsonl");
    installFakes();
    writeFileSync(transcript, "");
    const session = await startCodex({ cwd });
    const order: string[] = [];
    session.on("activity", (event) => {
      if (event.source === "transcript" && event.kind === "assistant_message") order.push("tx");
      if (event.kind === "status" && event.status === "ready") order.push("ready");
    });
    await observeTranscript(session.elwoodSessionId, cwd, transcript);
    appendFileSync(transcript, `${JSON.stringify(item("agent_message", { message: "done" }))}\n`);
    await ptys[0]!.dispatchHook(session.elwoodSessionId, stopEvent(cwd));
    expect(order).toEqual(["tx", "ready"]);
  });

  test("C-API-21 persona is submitted first, ahead of caller messages, and never persisted", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd, persona: "You are a terse reviewer." });
    const queued = session.sendMessage("hello");
    expect(ptys[0]!.writes).toEqual([]);
    ptys[0]!.emitData("codex rendered\r\n\u203a ");
    await expect.poll(() => ptys[0]!.writes.length).toBe(1);
    expect(ptys[0]!.writes[0]).toBe("\u001b[200~You are a terse reviewer.\u001b[201~\r");
    await ptys[0]!.dispatchHook(session.elwoodSessionId, stopEvent(cwd));
    await queued;
    expect(ptys[0]!.writes[1]).toBe("\u001b[200~hello\u001b[201~\r");
    const record = readFileSync(
      join(cwd, ".elwood", "sessions", session.elwoodSessionId, "session.json"),
      "utf8",
    );
    expect(record).not.toContain("terse reviewer");
  });

  test("C-API-21 undelivered persona is discarded when the session stops before ready", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd, persona: "never delivered" });
    await session.stop();
    await new Promise((resolve) => setImmediate(resolve));
    expect(session.status).toBe("stopped");
    expect(ptys[0]!.writes).toEqual([]);
  });
});

function item(type: string, payload: Record<string, unknown>) {
  return { type: "response_item", payload: { type, ...payload } };
}

function observeTranscript(elwoodSessionId: string, cwd: string, transcript: string) {
  return ptys[0]!.dispatchHook(elwoodSessionId, {
    hook_event_name: "SessionStart",
    session_id: "codex-1",
    transcript_path: transcript,
    cwd,
    model: "gpt-5.3-codex",
    source: "startup",
  });
}

const stopEvent = (cwd: string) => ({
  hook_event_name: "Stop",
  session_id: "codex-1",
  cwd,
  model: "gpt-5.3-codex",
  turn_id: "turn-1",
  stop_hook_active: false,
});
