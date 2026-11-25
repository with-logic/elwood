/** Check public Claude facade paste activity through FakePty and authenticated hooks (C-API-71). */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { ClaudeSession } from "../../src/index.ts";
import { claudePasteEnvelope } from "../fixtures/claude-paste.ts";
import { emptyComposer } from "../fixtures/owned-turn/composer.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test.each([
  "send",
  "stream",
] as const)("C-API-71 ClaudeSession.%s retains the native prompt presentation", async (method) => {
  installFakes();
  const cwd = tempDir();
  const transcript = join(cwd, "transcript.jsonl");
  writeFileSync(transcript, "");
  const session = new ClaudeSession({ cwd, autotrust: true });
  const live = await session.start();
  onTestFinished(async () => {
    vi.useRealTimers();
    await session.close();
  });
  const events: unknown[] = [];
  live.on("activity", (event) => {
    if (event.kind === "user_message") events.push(event);
  });
  const pty = ptys.at(-1)!;
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
  pty.emitData(emptyComposer("claude"));
  await vi.advanceTimersByTimeAsync(20);
  const text = "one\r\n\ttwo\nthree\nfour\n";
  const collect = async () => {
    for await (const event of session.stream(text)) void event;
  };
  const turn = method === "send" ? session.send(text) : collect();
  const outcome = turn.catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(500);
  expect(pty.writes).toContain("\r");
  const nativePrompt = claudePasteEnvelope("one\n    two\nthree\nfour", "c26a");
  await hook({ hook_event_name: "UserPromptSubmit", prompt: nativePrompt, prompt_id: "native" });
  pty.emitData(emptyComposer("claude"));
  await vi.advanceTimersByTimeAsync(100);
  await hook({ hook_event_name: "StopFailure", prompt_id: "native", error: "model_not_found" });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(await outcome).toMatchObject({ code: "turn_failed" });
  expect(events).toMatchObject([
    {
      text: "one\n    two\nthree\nfour",
      nativePrompt,
      promptProvenance: { origin: "unknown", input: "pasted" },
    },
  ]);
  expect(events[0]).not.toHaveProperty("sendId");
});
