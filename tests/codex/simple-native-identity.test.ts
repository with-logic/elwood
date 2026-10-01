/** Native UPS, content and resolved Stop retain one collection identity (C-API-48). */

import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { HeadlessCliSession } from "../../src/cli/session/index.ts";
import { CodexSession } from "../../src/index.ts";
import { effectiveRequest } from "../cli/main-fakes.ts";
import { codexIdle } from "../fixtures/owned-turn/composer.ts";
import { nativeHooks } from "../fixtures/owned-turn/session.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetFakes();
});

test.each([
  "facade",
  "headless CLI",
])("C-API-48 %s ignores pre-Enter acceptance and prior Stop oracle replacement", async (surface) => {
  installFakes();
  const cwd = tempDir();
  const transcript = join(cwd, "rollout.jsonl");
  writeFileSync(transcript, "");
  const owner = new CodexSession({ cwd });
  let result: Promise<unknown> | undefined;
  let settled = false;
  try {
    const live = await owner.start();
    await becomeReady(live.elwoodSessionId, cwd, { transcript_path: transcript });
    await expect.poll(() => live.status).toBe("ready");
    const facade =
      surface === "facade"
        ? owner
        : new HeadlessCliSession(
            effectiveRequest({ cwd, stateDir: join(cwd, ".elwood") }),
            live.elwoodSessionId,
            async () => live,
          );
    const pty = ptys[0]!;
    const hook = (input: Record<string, unknown>) =>
      nativeHooks("codex", live, cwd, pty).hook({
        transcript_path: transcript,
        ...input,
      });
    const accepted = (turn_id: string) =>
      hook({
        hook_event_name: "UserPromptSubmit",
        turn_id,
        prompt: "go\nnow",
      });
    const stop = (turn_id: string, last_assistant_message: string) =>
      hook({
        hook_event_name: "Stop",
        turn_id,
        last_assistant_message,
        stop_hook_active: false,
      });
    const text = (turn_id: string, value: string) =>
      appendFileSync(
        transcript,
        `${JSON.stringify({
          type: "response_item",
          turn_id,
          payload: {
            type: "message",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: value }],
          },
        })}\n`,
      );
    vi.useFakeTimers();
    result = facade.send("  go\u0000\r\nnow  ").then(
      (value) => {
        settled = true;
        return value;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(pty.writes).toContain("\u001b[200~  go\r\nnow  \u001b[201~");
    expect(pty.writes).not.toContain("\r");
    await accepted("prior");
    text("prior", "STALE");
    await stop("prior", "STALE");
    await vi.advanceTimersByTimeAsync(200);
    expect(pty.writes).toContain("\r");
    expect(settled).toBe(false);
    await accepted(""); // A string field alone is not a usable native generation.
    text("", "EMPTY-ID");
    await stop("", "EMPTY-ID");
    expect(settled).toBe(false);
    await accepted("owned");
    text("prior", "WRONG");
    text("owned", "PART ");
    pty.emitData(codexIdle);
    await vi.advanceTimersByTimeAsync(50);
    await stop("owned", "PART FINAL");
    await stop("prior", "PART ");
    await vi.advanceTimersByTimeAsync(2_100);
    expect(settled).toBe(false);
    text("owned", "FINAL");
    await stop("owned", "PART FINAL");
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(true);
    expect(await result).toBe("PART \n\nFINAL");
  } finally {
    vi.useRealTimers();
    await owner.close();
    await result;
  }
});
