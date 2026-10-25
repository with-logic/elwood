/**
 * A Codex turn the agent rejects fails with `turn_failed` (PRD §5.8, C-API-60). Codex fires no
 * `Stop` for it; the transcript `task_complete` carrying an `error` and the turn's own id is the
 * evidence. Another turn's failed `task_complete`, and a clean one, leave the turn running.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { HeadlessCliSession } from "../../src/cli/session/index.ts";
import { CodexSession, ElwoodError } from "../../src/index.ts";
import { effectiveRequest } from "../cli/main-fakes.ts";
import { codexIdle } from "../fixtures/owned-turn/composer.ts";
import { nativeHooks } from "../fixtures/owned-turn/session.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetFakes();
});

const rejectedBody =
  '{"type":"error","status":400,"error":{"code":"model_not_found","message":"no such model"}}';

function taskComplete(turn_id: string, error: unknown): string {
  const payload = { type: "task_complete", turn_id, last_agent_message: null, error };
  return `${JSON.stringify({ type: "event_msg", payload })}\n`;
}

test.each([
  "facade",
  "headless CLI",
])("C-API-60 %s fails a Codex turn with turn_failed on its own failed task_complete", async (surface) => {
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
    const hooks = nativeHooks("codex", live, cwd, pty);
    let records = 0;
    live.on("codex:transcript", () => {
      records += 1;
    });
    vi.useFakeTimers();
    result = facade.send("go").then(
      (value) => {
        settled = true;
        return value;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await vi.advanceTimersByTimeAsync(200);
    expect(pty.writes).toContain("\r");
    await hooks.hook({
      hook_event_name: "UserPromptSubmit",
      turn_id: "owned",
      prompt: "go",
      transcript_path: transcript,
    });
    // An earlier turn's rejection and a clean completion are not this turn's failure.
    appendFileSync(
      transcript,
      taskComplete("prior", { message: "earlier", codex_error_info: "other" }),
    );
    appendFileSync(transcript, taskComplete("owned", null));
    pty.emitData(codexIdle);
    // The transcript poll runs on real timers: let it read both records before the evidence.
    vi.useRealTimers();
    await expect.poll(() => records).toBe(2);
    expect(settled).toBe(false);
    appendFileSync(
      transcript,
      taskComplete("owned", { message: rejectedBody, codex_error_info: "other" }),
    );
    await expect.poll(() => settled).toBe(true);
    const error = await result;
    expect(error).toBeInstanceOf(ElwoodError);
    expect(error).toMatchObject({
      code: "turn_failed",
      message: rejectedBody,
      details: { agentError: "other" },
    });
  } finally {
    vi.useRealTimers();
    await owner.close();
    await result;
  }
});
