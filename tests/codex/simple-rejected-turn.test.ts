/**
 * A Codex turn the agent rejects fails with `turn_failed` (PRD §5.8, C-API-60). Codex fires no
 * `Stop` for it; the transcript `task_complete` carrying an `error` and the turn's own id is the
 * evidence. Another turn's failed `task_complete`, and a clean one, leave the turn running, and
 * a rejected turn still holds the session until its real ready boundary.
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

/** Codex mid-turn: the working line above its empty composer. */
const codexWorking =
  "\u001b[2J\u001b[H• Working (1s • esc to interrupt)\r\n\r\n› Ask Codex to do anything\r\n  gpt-5.3-codex high\u001b[3;3H";

const rejectedBody =
  '{"type":"error","status":400,"error":{"code":"model_not_found","message":"no such model"}}';

/** A `task_complete` record; an `undefined` error is omitted from the JSON entirely. */
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
    appendFileSync(transcript, taskComplete("owned", undefined)); // no `error` field at all
    pty.emitData(codexIdle);
    // The transcript poll runs on real timers: let it read every record before the evidence.
    vi.useRealTimers();
    await expect.poll(() => records).toBe(3);
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

test("C-API-60 a Codex turn rejected while still running holds the session until it is ready", async () => {
  installFakes();
  const cwd = tempDir();
  const transcript = join(cwd, "rollout.jsonl");
  writeFileSync(transcript, "");
  const owner = new CodexSession({ cwd });
  const settle = (prompt: string) =>
    owner.send(prompt).then(
      (reply) => reply,
      (error: unknown) => error,
    );
  let first: Promise<unknown> | undefined;
  let second: Promise<unknown> | undefined;
  try {
    const live = await owner.start();
    await becomeReady(live.elwoodSessionId, cwd, { transcript_path: transcript });
    await expect.poll(() => live.status).toBe("ready");
    const pty = ptys[0]!;
    first = settle("go");
    await expect.poll(() => pty.writes.includes("\r")).toBe(true);
    await nativeHooks("codex", live, cwd, pty).hook({
      hook_event_name: "UserPromptSubmit",
      turn_id: "owned",
      prompt: "go",
      transcript_path: transcript,
    });
    // The rejection lands while Codex still paints the turn as working, its composer empty.
    pty.emitData(codexWorking);
    await expect.poll(() => live.status).toBe("running");
    appendFileSync(transcript, taskComplete("owned", { message: rejectedBody }));
    expect(await first).toMatchObject({ code: "turn_failed", message: rejectedBody });
    // The serializer hands the successor to the session only once the slot is released.
    const submit = vi.spyOn(live, "sendMessage");
    second = settle("next");
    // Longer than the post-failure drain, so a slot released on the failure alone would show.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(submit).not.toHaveBeenCalled();
    pty.emitData(codexIdle);
    // The rendered end makes the session ready; the post-failure drain then releases the slot.
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce(), { timeout: 5_000 });
  } finally {
    await owner.close();
    await first;
    await second;
  }
});
