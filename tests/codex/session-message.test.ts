/**
 * Conformance tests for Codex adapter-neutral queued messages.
 * Covers PRD §5.3, C-API-19, and C-API-21.
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { startCodex } from "../../src/index.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("CodexSessionApi message submission", () => {
  test("C-CODEX-12 an update prompt blocks queued persona input until the screen clears", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd, persona: "Never update from the live TUI." });
    ptys[0]!.emitData("Update available! 0.151.0 -> 0.152.0\r\n  1. Update now");
    await session.terminal.settled();
    // Current Codex releases can repaint only the safe continuation choices.
    ptys[0]!.emitData("\u001b[2J\u001b[H  2. Skip\r\n  3. Skip until next version");
    await session.terminal.settled();
    await becomeReady(session.elwoodSessionId, cwd);
    await new Promise((resolve) => setImmediate(resolve));
    // The safe option is written, but no persona paste/Enter reaches the rendered dialog.
    expect(ptys[0]!.writes).toEqual(["2"]);
    ptys[0]!.emitData("\u001b[2J\u001b[H› ");
    await session.terminal.settled();
    await expect.poll(() => ptys[0]!.writes.length).toBeGreaterThan(1);
    expect(ptys[0]!.writes).toContain("\u001b[200~Never update from the live TUI.\u001b[201~");
  });

  test("C-API-19 first sendMessage waits for the SessionStart readiness hook", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startCodex({ cwd });
    const queued = session.sendMessage("hello");
    expect(ptys[0]!.writes).toEqual([]);
    // A boot-time composer frame must NOT release the queued message (C-API-28).
    ptys[0]!.emitData("codex rendered\r\n\u203a ");
    await new Promise((resolve) => setImmediate(resolve));
    expect(ptys[0]!.writes).toEqual([]);
    // Codex's SessionStart hook is the real pre-input readiness signal.
    await becomeReady(session.elwoodSessionId, cwd);
    await queued;
    // C-API-31/FIFO: `queued` resolves only after the paste and its
    // separate submitting Enter have both landed, in order.
    expect(ptys[0]!.writes[0]).toBe("\u001b[200~hello\u001b[201~");
    expect(ptys[0]!.writes).toContain("\r");
    expect(session.status).toBe("running");
  });

  test("C-API-20 C-CODEX-16 flushes modern final-answer text before terminal exit", async () => {
    const cwd = tempDir();
    const transcript = join(cwd, "codex.jsonl");
    installFakes();
    writeFileSync(transcript, "");
    const session = await startCodex({ cwd });
    const order: string[] = [];
    session.on("activity", (event) => {
      if (event.source === "transcript" && event.kind === "assistant_message")
        order.push(`tx:${event.text}`);
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
    appendFileSync(
      transcript,
      `${JSON.stringify(finalAnswer("Done. @Tech Lead please review."))}\n`,
    );
    ptys[0]!.emitExit({ exitCode: 0 });
    expect(order).toEqual(["tx:Done. @Tech Lead please review.", "exit", "exited"]);
  });

  test("C-API-20 flushes transcript activity before Stop readiness", async () => {
    const cwd = tempDir();
    const transcript = join(cwd, "codex.jsonl");
    installFakes();
    writeFileSync(transcript, "");
    const session = await startCodex({ cwd });
    const order: string[] = [];
    // observeTranscript is the SessionStart hook, which now also fires initial
    // readiness (C-API-28); begin recording only the Stop cycle so the assertion
    // captures the transcript-flush-before-Stop-readiness ordering under test.
    await observeTranscript(session.elwoodSessionId, cwd, transcript);
    // Drive a turn into `running` so the Stop hook's readiness is a real
    // running->ready transition (SessionStart already consumed starting->ready).
    ptys[0]!.emitData("• Working (1s • esc to interrupt)\r\n› ");
    await expect.poll(() => session.status).toBe("running");
    session.on("activity", (event) => {
      if (event.source === "transcript" && event.kind === "assistant_message") order.push("tx");
      if (event.kind === "status" && event.status === "ready") order.push("ready");
    });
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
    await becomeReady(session.elwoodSessionId, cwd);
    await expect.poll(() => ptys[0]!.writes.length).toBe(1);
    expect(ptys[0]!.writes.filter((w) => w !== "\r")[0]).toBe(
      "\u001b[200~You are a terse reviewer.\u001b[201~",
    );
    await ptys[0]!.dispatchHook(session.elwoodSessionId, stopEvent(cwd));
    await queued;
    expect(ptys[0]!.writes.filter((w) => w !== "\r")[1]).toBe("\u001b[200~hello\u001b[201~");
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

function finalAnswer(text: string) {
  return item("message", {
    role: "assistant",
    phase: "final_answer",
    content: [{ type: "output_text", text }],
  });
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
