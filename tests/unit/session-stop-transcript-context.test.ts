/** Stop transcript polling must not inherit expired callback input authority (C-HOOK-04). */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { startClaude, startCodex } from "../../src/index.ts";
import * as claude from "../claude/helpers.ts";
import * as codex from "../codex/helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  claude.resetFakes();
  codex.resetFakes();
});

for (const agent of ["claude", "codex"] as const) {
  test(`C-HOOK-04 ${agent} later transcript activity admits normal follow-up input`, async () => {
    const helper = agent === "claude" ? claude : codex;
    helper.installFakes();
    const cwd = helper.tempDir();
    const transcript = join(cwd, "transcript.jsonl");
    writeFileSync(transcript, "");
    const session = await (agent === "claude" ? startClaude : startCodex)({ cwd });
    const pty = helper.ptys[0]!;
    let heard = false;
    let result: Promise<unknown> | undefined;
    const events: {
      on(name: "activity", listener: (event: { readonly kind: string }) => unknown): unknown;
    } = session;
    try {
      await pty.dispatchHook(session.elwoodSessionId, {
        hook_event_name: "Stop",
        session_id: `${agent}-1`,
        cwd,
        transcript_path: transcript,
        turn_id: "turn-1",
        stop_hook_active: false,
      });
      events.on("activity", (event) => {
        if (event.kind !== "assistant_message" || heard) return;
        heard = true;
        result = session.sendPrompt("poll follow-up").then(
          () => "sent",
          (error: unknown) => error,
        );
      });
      appendFileSync(
        transcript,
        `${JSON.stringify(
          agent === "claude"
            ? { type: "assistant", message: { content: [{ type: "text", text: "later" }] } }
            : {
                type: "response_item",
                payload: {
                  type: "message",
                  role: "assistant",
                  phase: "final_answer",
                  content: [{ type: "output_text", text: "later" }],
                },
              },
        )}\n`,
      );
      await vi.waitFor(() => expect(heard).toBe(true), { timeout: 2_000 });
      expect(heard).toBe(true);
      expect(await result).toBe("sent");
      expect(pty.writes.some((value) => value.includes("poll follow-up"))).toBe(true);
    } finally {
      await session.teardown();
    }
  });
}
