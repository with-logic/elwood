/**
 * A Claude turn ended by `StopFailure` fails as `turn_failed` through both shipped facades —
 * the public `ClaudeSession` and the headless CLI session — with the hook dispatched through
 * the real bridge (PRD §5.8/§12A.2, C-API-59/C-CLI-28).
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { startClaudeWithId } from "../../src/claude/session/index.ts";
import { HeadlessCliSession } from "../../src/cli/session/index.ts";
import type { ElwoodAgentSession } from "../../src/core/agent-session.ts";
import { ClaudeSession } from "../../src/index.ts";
import { effectiveRequest } from "../cli/main-fakes.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  resetFakes();
});

const working = "\u001b[2J\u001b[H❯ \r\n  ⏵⏵ bypass permissions · esc to interrupt · ← for agents";
const idle = "\u001b[2J\u001b[H❯ \r\n  ⏵⏵ bypass permissions · ← for agents";

function facade(kind: "public" | "cli", cwd: string) {
  if (kind === "public") return new ClaudeSession({ cwd, autotrust: true });
  const stateDir = join(cwd, ".elwood"); // the default the fake PTY reads its bridge from
  const request = effectiveRequest({ agent: "claude", cwd, stateDir });
  return new HeadlessCliSession(request, "s1", () =>
    startClaudeWithId({ cwd, stateDir, autotrust: true }, "s1"),
  );
}

test.each([
  "public",
  "cli",
] as const)("C-API-59 C-CLI-28 a %s Claude turn ended by StopFailure fails as turn_failed", async (kind) => {
  installFakes();
  const cwd = tempDir();
  const transcript = join(cwd, "transcript.jsonl");
  writeFileSync(transcript, "");
  const session = facade(kind, cwd);
  const result = session.send("go").then(
    (reply) => ({ reply }),
    (error: unknown) => ({ error }),
  );
  try {
    const live: ElwoodAgentSession = await session.start();
    const pty = ptys[0]!;
    const hook = (fields: Record<string, unknown>) =>
      pty.dispatchHook(live.elwoodSessionId, {
        session_id: "claude-1",
        cwd,
        transcript_path: transcript,
        ...fields,
      });
    vi.useFakeTimers();
    await hook({ hook_event_name: "SessionStart", source: "startup", model: "bogus" });
    await hook({
      hook_event_name: "InstructionsLoaded",
      file_path: "/tmp/CLAUDE.md",
      memory_type: "Project",
      load_reason: "session_start",
    });
    await vi.advanceTimersByTimeAsync(500);
    await hook({ hook_event_name: "UserPromptSubmit", prompt: "go" });
    pty.emitData(working);
    await vi.advanceTimersByTimeAsync(50);
    pty.emitData(idle);
    await vi.advanceTimersByTimeAsync(100);
    await hook({
      hook_event_name: "StopFailure",
      error: "model_not_found",
      last_assistant_message: "There's an issue with the selected model (bogus).",
    });
    await vi.advanceTimersByTimeAsync(5_000);
    const outcome = await result;
    expect(outcome).toEqual({ error: expect.objectContaining({ code: "turn_failed" }) });
    expect(outcome).toMatchObject({
      error: {
        message: "Claude rejected the turn: model_not_found",
        details: { info: "model_not_found" },
      },
    });
    // A rejection is never replayed by acceptance recovery: exactly one submission.
    expect(pty.writes.filter((write) => write.includes("go"))).toHaveLength(1);
  } finally {
    vi.useRealTimers();
    await session.close();
    await result;
  }
});
