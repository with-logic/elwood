/**
 * Conformance tests for Claude adapter-neutral queued messages.
 * Covers PRD §5.3, C-API-19, and C-API-21.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("ClaudeSessionApi message submission", () => {
  test("C-API-19 first sendMessage waits for InstructionsLoaded readiness", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    const queued = session.sendMessage("hello");
    expect(ptys[0]!.writes).toEqual([]);
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "InstructionsLoaded",
      session_id: "claude-1",
      cwd,
      file_path: "/tmp/CLAUDE.md",
      memory_type: "Project",
      load_reason: "session_start",
    });
    await queued;
    // C-API-31/FIFO: `queued` resolves only after the paste and its
    // separate submitting Enter have both landed, in order.
    expect(ptys[0]!.writes[0]).toBe("\u001b[200~hello\u001b[201~");
    expect(ptys[0]!.writes).toContain("\r");
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "InstructionsLoaded",
      session_id: "claude-1",
      cwd,
      file_path: "/tmp/LOCAL.md",
      memory_type: "Local",
      load_reason: "session_start",
    });
    expect(session.status).toBe("running");
  });

  test("C-API-21 persona is submitted first, ahead of caller messages, and never persisted", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd, persona: "You are a terse reviewer." });
    const queued = session.sendMessage("hello");
    expect(ptys[0]!.writes).toEqual([]);
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "InstructionsLoaded",
      session_id: "claude-1",
      cwd,
      file_path: "/tmp/CLAUDE.md",
      memory_type: "Project",
      load_reason: "session_start",
    });
    // A persona turn cannot finish before its submitting Enter reaches the CLI.
    await expect
      .poll(() => ptys[0]!.writes)
      .toEqual(["\u001b[200~You are a terse reviewer.\u001b[201~", "\r"]);
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "Stop",
      session_id: "claude-1",
      cwd,
      stop_hook_active: false,
    });
    await queued;
    expect(ptys[0]!.writes.filter((w) => w !== "\r")[1]).toBe("\u001b[200~hello\u001b[201~");
    const record = readFileSync(
      join(cwd, ".elwood", "sessions", session.elwoodSessionId, "session.json"),
      "utf8",
    );
    expect(record).not.toContain("terse reviewer");
  });

  test("C-API-36 a failed readiness listener still releases queued input", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    const off = session.on("status", () => {
      off();
      throw new Error("listener failed");
    });
    const queued = session.sendMessage("hello");
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "InstructionsLoaded",
      session_id: "claude-1",
      cwd,
      file_path: "/tmp/CLAUDE.md",
      memory_type: "Project",
      load_reason: "session_start",
    });
    await queued;
    expect(ptys[0]!.writes[0]).toBe("\u001b[200~hello\u001b[201~");
  });

  test("C-API-25 terminated sessions reject calls instead of throwing synchronously", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await session.stop();
    // Creating the promises must not throw; every failure arrives as a rejection.
    const calls = [
      session.sendPrompt("late"),
      session.sendMessage("late"),
      session.sendGuidance("late"),
      session.sendKeys("late"),
      session.resize({ cols: 10, rows: 5 }),
      session.compact(),
      session.listModels(),
      session.setModel("haiku"),
    ];
    for (const call of calls) {
      await expect(call).rejects.toMatchObject({ code: "session_not_running" });
    }
  });

  test("C-API-25 a terminated session rejects a MALFORMED-image send as session_not_running", async () => {
    // Terminal status must take precedence over image validation: a bad `images` on a
    // stopped session rejects `session_not_running`, NOT `invalid_image` (C-API-25/44).
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    await session.stop();
    for (const bad of [
      { data: new Uint8Array(0), format: "png" as const },
      {} as never,
      "" as never,
    ]) {
      await expect(session.sendMessage("x", { images: [bad] })).rejects.toMatchObject({
        code: "session_not_running",
      });
    }
  });

  test("C-API-21 undelivered persona is discarded when the session stops before ready", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd, persona: "never delivered" });
    await session.stop();
    await new Promise((resolve) => setImmediate(resolve));
    expect(session.status).toBe("stopped");
    expect(ptys[0]!.writes).toEqual([]);
  });
});
