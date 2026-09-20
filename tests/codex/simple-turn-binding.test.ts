/** Real facade, hook socket, and transcript watcher turn isolation (PRD §5.8, C-API-48). */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { CodexSession, resumeCodex } from "../../src/index.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

// Resume through the real factory while retaining CodexSession's actual turn-reader wiring.
class ResumedCodexSession extends CodexSession {
  private readonly cwd: string;
  private readonly id: string;
  constructor(cwd: string, id: string) {
    super({ cwd });
    this.cwd = cwd;
    this.id = id;
  }
  protected override launch() {
    return resumeCodex({ cwd: this.cwd, elwoodSessionId: this.id });
  }
}

test.each([
  false,
  true,
])("C-API-48 real Codex turn binding rejects replay (resumed=%s)", async (resume) => {
  installFakes();
  const cwd = tempDir();
  const transcript = join(cwd, "rollout.jsonl");
  writeFileSync(transcript, "");
  let facade = new CodexSession({ cwd });
  let session = await facade.start();
  await becomeReady(session.elwoodSessionId, cwd, { transcript_path: transcript });
  if (resume) {
    await facade.close();
    facade = new ResumedCodexSession(cwd, session.elwoodSessionId);
    session = await facade.start();
    ptys[1]!.emitData("\u001b[2J\u001b[H› ");
    await session.terminal.settled();
    await expect.poll(() => session.status).toBe("ready");
  }
  const pty = ptys.at(-1)!;
  const hook = (payload: Record<string, unknown>) =>
    pty.dispatchHook(session.elwoodSessionId, {
      session_id: "codex-1",
      cwd,
      transcript_path: transcript,
      model: "gpt-5.3-codex",
      ...payload,
    });
  const appendText = (turn_id: string, text: string) =>
    appendFileSync(
      transcript,
      `${JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          turn_id,
          content: [{ type: "output_text", text }],
        },
      })}\n`,
    );
  const seen: string[] = [];
  facade.on("activity", (event) => {
    if (event.kind === "assistant_message") seen.push(`${event.turnId}:${event.text}`);
  });
  try {
    for (const prompt of ["first", "second"]) {
      const enters = pty.writes.filter((write) => write === "\r").length;
      const result = facade.send(prompt, { catchUpMs: 200, timeoutMs: 2_000 });
      void result.catch(() => undefined);
      await expect.poll(() => pty.writes.filter((write) => write === "\r").length).toBe(enters + 1);
      if (prompt === "second") {
        await hook({ hook_event_name: "Stop", turn_id: "first", stop_hook_active: false });
      }
      await hook({ hook_event_name: "UserPromptSubmit", turn_id: prompt, prompt });
      appendText("older", "STALE");
      appendText(prompt, prompt.toUpperCase());
      await hook({
        hook_event_name: "Stop",
        turn_id: prompt,
        stop_hook_active: false,
        last_assistant_message: prompt.toUpperCase(),
      });
      expect(await result).toBe(prompt.toUpperCase());
    }
    expect(seen).toEqual(["older:STALE", "first:FIRST", "older:STALE", "second:SECOND"]);
  } finally {
    await facade.close();
  }
});
