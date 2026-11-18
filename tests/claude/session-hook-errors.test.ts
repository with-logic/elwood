/**
 * Conformance tests for Claude hook handler failure behavior.
 * Covers PRD §6 and §10.
 */

import { mkdirSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { startClaude, startOrResumeClaude } from "../../src/index.ts";
import { readSessionRecord } from "../../src/state/store.ts";
import { onlyLaunchArtifact } from "../helpers/launch-artifacts.ts";
import { installFakes, ptys, readBridgeScript, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("ClaudeSessionApi hook errors", () => {
  test("C-API-17 C-HOOK-04 emits hookError and fails open on timeout", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({
      cwd,
      hookTimeoutMs: 1,
      hooks: { Stop: () => new Promise(() => {}) },
    });
    const errors: string[] = [];
    const activity: string[] = [];
    const offError = session.on("hookError", (event) => errors.push(event.category));
    session.on("activity", (event) => activity.push(event.kind));
    const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "Stop",
      session_id: "claude-1",
      cwd,
    });
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(errors).toEqual(["timeout"]);
    expect(activity).toContain("hook_error");
    offError();
  });

  test("C-HOOK-05 non-Error handler rejections fail open with a generic message", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({
      cwd,
      hooks: { UserPromptSubmit: () => Promise.reject("string failure") },
    });
    const errors: string[] = [];
    session.on("hookError", (event) => errors.push(`${event.category}:${event.message}`));
    const result = await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "UserPromptSubmit",
      session_id: "claude-1",
      cwd,
      prompt: "hello",
    });
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(errors).toEqual(["handler_error:Hook handler failed"]);
    expect(readSessionRecord(join(cwd, ".elwood"), session.elwoodSessionId).claude.resumeId).toBe(
      "claude-1",
    );
  });

  test("C-CLAUDE-08 a submission released after shutdown cannot establish resumability", async () => {
    const cwd = tempDir();
    installFakes();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const session = await startClaude({
      cwd,
      hooks: {
        UserPromptSubmit: async () => {
          entered.resolve();
          await release.promise;
        },
      },
    });
    const id = session.elwoodSessionId;
    const stateDir = join(cwd, ".elwood");
    const bridge = readBridgeScript(
      onlyLaunchArtifact(join(stateDir, "sessions", id), "hook-bridge"),
    );
    const client = createConnection({ path: bridge.socketPath });
    let reply = "";
    const closed = new Promise<void>((resolve, reject) => {
      client.on("data", (chunk) => {
        reply += chunk.toString("utf8");
      });
      client.once("error", reject);
      client.once("close", resolve);
      client.once("connect", () =>
        client.write(
          `${JSON.stringify({
            token: bridge.token,
            elwoodSessionId: id,
            input: JSON.stringify({
              hook_event_name: "UserPromptSubmit",
              session_id: "unsaved",
              cwd,
              prompt: "hello",
            }),
          })}\n`,
        ),
      );
    });
    const results: string[] = [];
    session.on("activity", (event) => results.push(event.kind));
    try {
      await entered.promise;
      await session.stop();
      await closed;
      expect(reply).toBe("");
    } finally {
      release.resolve();
    }
    await expect.poll(() => results).toContain("hook_result");
    expect(readSessionRecord(stateDir, id).claude.resumeId).toBeUndefined();
    const next = await startOrResumeClaude({ cwd, elwoodSessionId: id });
    expect(next.resumed).toBe(false);
    await next.session.stop();
  });

  test("C-HOOK-22 a resume-id write failure preserves hook result delivery and diagnostics", async () => {
    const cwd = tempDir();
    installFakes();
    const session = await startClaude({ cwd });
    const id = session.elwoodSessionId;
    const record = join(cwd, ".elwood", "sessions", id, "session.json");
    unlinkSync(record);
    mkdirSync(record);
    const results: string[] = [];
    const warnings: unknown[] = [];
    session.on("activity", (event) => results.push(event.kind));
    session.on("warning", (event) => warnings.push(event));
    const result = await ptys[0]!.dispatchHook(id, {
      hook_event_name: "UserPromptSubmit",
      session_id: "unsaved",
      cwd,
      prompt: "hello",
    });
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(results.filter((kind) => kind === "hook_result")).toEqual(["hook_result"]);
    expect(warnings).toEqual([
      expect.objectContaining({ code: "hook_observer_failed", phase: "lifecycle" }),
    ]);
  });
});
