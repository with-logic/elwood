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
import { claudeComposer, claudeTty } from "../fixtures/trust-composer.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetFakes();
});

const working = "\u001b[2J\u001b[H❯ \r\n  ⏵⏵ bypass permissions · esc to interrupt · ← for agents";
const idle = "\u001b[2J\u001b[H❯ \r\n  ⏵⏵ bypass permissions · ← for agents";

/** The facade under test and the rejected turn it runs: a user `send` or the CLI persona. */
function facade(kind: "public" | "cli" | "cli persona", cwd: string, prompt: string) {
  if (kind === "public") {
    const session = new ClaudeSession({ cwd, autotrust: true });
    return { session, turn: () => session.send(prompt) };
  }
  const stateDir = join(cwd, ".elwood"); // the default the fake PTY reads its bridge from
  const persona = kind === "cli persona" ? { persona: prompt } : {};
  const request = effectiveRequest({ agent: "claude", cwd, stateDir, ...persona });
  const session = new HeadlessCliSession(request, "s1", () =>
    startClaudeWithId({ cwd, stateDir, autotrust: true }, "s1"),
  );
  // HeadlessCliSession.setup() sends the persona as a real turn before the user prompt.
  const turn = () => (kind === "cli" ? session.send(prompt) : session.setup().then(() => ""));
  return { session, turn };
}

test.each([
  ["public", "go"],
  ["cli", "go"],
  ["cli persona", "be careful"],
] as const)("C-API-59 C-CLI-28 a %s Claude turn ended by StopFailure fails as turn_failed", async (kind, prompt) => {
  installFakes();
  const cwd = tempDir();
  const transcript = join(cwd, "transcript.jsonl");
  writeFileSync(transcript, "");
  const { session, turn } = facade(kind, cwd, prompt);
  const result = turn().then(
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
    await hook({ hook_event_name: "UserPromptSubmit", prompt });
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
        details: { agentError: "model_not_found" },
      },
    });
    // A rejection is never replayed by acceptance recovery: exactly one submission.
    expect(pty.writes.filter((write) => write.includes(prompt))).toHaveLength(1);
  } finally {
    vi.useRealTimers();
    await session.close();
    await result;
  }
});

test("C-API-59 a StopFailure arriving after its turn settled does not fail the next turn", async () => {
  installFakes();
  const cwd = tempDir();
  const transcript = join(cwd, "transcript.jsonl");
  writeFileSync(transcript, "");
  const session = new ClaudeSession({ cwd, autotrust: true });
  const settle = (reply: Promise<string>) =>
    reply.then(
      (text) => ({ reply: text }),
      (error: unknown) => ({ error }),
    );
  const first = settle(session.send("one"));
  let second: ReturnType<typeof settle> | undefined;
  try {
    const live = await session.start();
    const pty = ptys[0]!;
    // A real empty composer is the positive proof each submission and draft cleanup awaits.
    const composer = `\u001b[2J\u001b[H${claudeTty(claudeComposer)}`;
    const write = pty.write.bind(pty);
    vi.spyOn(pty, "write").mockImplementation((data) => {
      write(data);
      if (String(data) === "\r" || String(data) === "\u0015\u000b") pty.emitData(composer);
    });
    const hook = (fields: Record<string, unknown>) =>
      pty.dispatchHook(live.elwoodSessionId, {
        session_id: "claude-1",
        cwd,
        transcript_path: transcript,
        ...fields,
      });
    const turn = async (prompt: string, promptId: string) => {
      await hook({ hook_event_name: "UserPromptSubmit", prompt, prompt_id: promptId });
      pty.emitData(working);
      await vi.advanceTimersByTimeAsync(50);
      pty.emitData(composer);
    };
    vi.useFakeTimers();
    await hook({ hook_event_name: "SessionStart", source: "startup", model: "bogus" });
    await hook({
      hook_event_name: "InstructionsLoaded",
      file_path: "/tmp/CLAUDE.md",
      memory_type: "Project",
      load_reason: "session_start",
    });
    pty.emitData(composer);
    await vi.advanceTimersByTimeAsync(500);
    await turn("one", "p1");
    await vi.advanceTimersByTimeAsync(5_000); // no hook yet: the quiet window settles turn one
    expect(await first).toEqual({ reply: "" });
    second = settle(session.send("two"));
    await vi.waitFor(
      () => {
        const paste = pty.writes.findIndex((data) => data.includes("two"));
        expect(paste).toBeGreaterThanOrEqual(0);
        expect(pty.writes.slice(paste + 1)).toContain("\r");
      },
      { timeout: 5_000 },
    );
    // Turn one's rejection lands late: after turn two's Enter, before its own submit hook.
    await hook({
      hook_event_name: "StopFailure",
      prompt_id: "p1",
      error: "model_not_found",
      last_assistant_message: "There's an issue with the selected model (bogus).",
    });
    await turn("two", "p2");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await second).toEqual({ reply: "" });
  } finally {
    vi.useRealTimers();
    await session.close();
    await first;
    await second;
  }
});
