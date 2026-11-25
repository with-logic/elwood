/** Check public Claude facade paste activity through FakePty and authenticated hooks (C-API-71). */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { ClaudeSession } from "../../src/index.ts";
import { claudePasteEnvelope } from "../fixtures/claude-paste.ts";
import { emptyComposer } from "../fixtures/owned-turn/composer.ts";
import { nativeHooks } from "../fixtures/owned-turn/session.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test.each([
  ["send", (session: ClaudeSession, text: string) => session.send(text)],
  [
    "stream",
    async (session: ClaudeSession, text: string) => {
      for await (const event of session.stream(text)) void event;
    },
  ],
] as const)("C-API-71 ClaudeSession.%s retains the native prompt presentation", async (_method, submit) => {
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
  const { hook, ready } = nativeHooks("claude", live, cwd, pty);
  vi.useFakeTimers();
  await hook({
    hook_event_name: "SessionStart",
    source: "startup",
    model: "bogus",
    transcript_path: transcript,
  });
  await ready();
  pty.emitData(emptyComposer("claude"));
  await vi.advanceTimersByTimeAsync(20);
  const text = "one\r\n\ttwo\nthree\nfour\n";
  const outcome = submit(session, text).catch((error: unknown) => error);
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
