/** Persona completion cannot settle an ergonomic caller turn (PRD §5.8, C-API-21/48). */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { CodexSession } from "../../src/index.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  resetFakes();
});

test.each([
  false,
  true,
])("C-API-21 close releases a caller waiting for persona (submitted=%s)", async (submitted) => {
  installFakes();
  const cwd = tempDir();
  const facade = new CodexSession({ cwd, persona: "persona" });
  const result = facade.send("caller").catch((error: unknown) => error);
  try {
    const session = await facade.start();
    if (submitted) {
      await becomeReady(session.elwoodSessionId, cwd);
      await expect.poll(() => ptys[0]!.writes).toContain("\r");
    }
    await facade.close();
    expect(await result).toMatchObject({ code: "session_not_running" });
    expect(ptys[0]!.writes.some((write) => write.includes("caller"))).toBe(false);
  } finally {
    await facade.close();
  }
});

test.each(["go", "  go  "])("C-API-48 persona cannot settle caller %j", async (prompt) => {
  installFakes();
  const cwd = tempDir();
  const transcript = join(cwd, "rollout.jsonl");
  writeFileSync(transcript, "");
  const facade = new CodexSession({ cwd, persona: "go" });
  let settled = false;
  const result = facade.send(prompt).then(
    (value) => {
      settled = true;
      return value;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  try {
    const session = await facade.start();
    await becomeReady(session.elwoodSessionId, cwd, { transcript_path: transcript });
    await expect.poll(() => ptys[0]!.writes).toEqual(["\u001b[200~go\u001b[201~", "\r"]);
    vi.useFakeTimers();
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "UserPromptSubmit",
      session_id: "codex-1",
      cwd,
      model: "gpt-5.3-codex",
      turn_id: "persona-turn",
      prompt: "go",
    });
    ptys[0]!.emitData("\u001b[2J\u001b[H• Working (3s • esc to interrupt)\r\n› ");
    await vi.advanceTimersByTimeAsync(50);
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "Stop",
      session_id: "codex-1",
      cwd,
      model: "gpt-5.3-codex",
      turn_id: "persona-turn",
      stop_hook_active: false,
      last_assistant_message: "",
    });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(settled).toBe(false);
    expect(ptys[0]!.writes.filter((write) => write.startsWith("\u001b[200~"))).toEqual([
      "\u001b[200~go\u001b[201~",
      `\u001b[200~${prompt}\u001b[201~`,
    ]);
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "UserPromptSubmit",
      session_id: "codex-1",
      cwd,
      model: "gpt-5.3-codex",
      turn_id: "caller-turn",
      prompt: prompt.trim(),
    });
    appendFileSync(
      transcript,
      `${JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "CALLER" }],
        },
      })}\n`,
    );
    await ptys[0]!.dispatchHook(session.elwoodSessionId, {
      hook_event_name: "Stop",
      session_id: "codex-1",
      cwd,
      model: "gpt-5.3-codex",
      turn_id: "caller-turn",
      stop_hook_active: false,
      last_assistant_message: "CALLER",
    });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await result).toBe("CALLER");
  } finally {
    vi.useRealTimers();
    await facade.close();
    await result;
  }
});
