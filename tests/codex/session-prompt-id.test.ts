/** Exercise caller IDs across the Codex queue, terminal and native hook (C-API-70). */
import { afterEach, expect, expectTypeOf, onTestFinished, test, vi } from "vitest";
import type { ElwoodActivityEvent } from "../../src/core/activity/index.ts";
import { composerClearKeys } from "../../src/core/input/constants.ts";
import { cancellableSubmission } from "../../src/core/input/submission-cancel.ts";
import { startCodex } from "../../src/index.ts";
import { codexSmallComposer, codexTty } from "../fixtures/trust-composer.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test("C-API-70 Codex activity types include native fallback without API metadata", () => {
  type CodexUserMessage = Extract<ElwoodActivityEvent, { kind: "user_message"; agent: "codex" }>;
  expectTypeOf<{
    readonly kind: "user_message";
    readonly agent: "codex";
    readonly source: "hook";
    readonly hookEventName: "UserPromptSubmit";
    readonly label: "user";
    readonly elwoodSessionId: string;
    readonly text: string;
  }>().toExtend<CodexUserMessage>();
});

async function setup() {
  installFakes();
  const cwd = tempDir();
  const session = await startCodex({ cwd });
  onTestFinished(() => session.teardown());
  const pty = ptys[0]!;
  await becomeReady(session.elwoodSessionId, cwd);
  const paint = async () => {
    pty.emitData(`\x1b[2J\x1b[H${codexTty(codexSmallComposer)}`);
    await session.terminal.settled();
  };
  await paint();
  await session.waitForStatus((status) => status === "ready");
  const messages: ElwoodActivityEvent[] = [];
  session.on("activity", (event) => {
    if (event.kind === "user_message") messages.push(event);
  });
  const trySubmit = (prompt: string, turnId = "native-turn") =>
    pty.dispatchHook(session.elwoodSessionId, {
      cwd,
      session_id: "codex-id",
      hook_event_name: "UserPromptSubmit",
      prompt,
      turn_id: turnId,
    });
  return { session, pty, paint, messages, trySubmit };
}

test.each([
  "sendMessage",
  "sendPrompt",
  "sendGuidance",
] as const)("C-API-70 %s preserves API text and caller ID with the native hook", async (send) => {
  const { session, messages, pty, trySubmit } = await setup();
  const text = " first\u0000\r\nsecond ";
  await session[send](text, { sendId: "caller-id" });
  expect(pty.writes).toEqual(["\x1b[200~ first\r\nsecond \x1b[201~", "\r"]);
  await trySubmit("first\nsecond");
  expect(messages).toMatchObject([
    {
      text,
      sendId: "caller-id",
      turnId: "native-turn",
      nativePrompt: "first\nsecond",
      promptProvenance: { origin: "api", input: "pasted" },
      raw: { prompt: "first\nsecond" },
    },
  ]);
});

test("C-API-70 a reused caller ID and duplicated native hook have separate identities", async () => {
  const { session, messages, trySubmit, paint } = await setup();
  await session.sendMessage(" \uFEFFfirst\uFEFF ", { sendId: "reused" });
  await trySubmit("\uFEFFfirst\uFEFF", "first-turn");
  await paint();
  await session.sendGuidance(" second ", { sendId: "reused" });
  await trySubmit("second", "first-turn");
  await trySubmit("second", "second-turn");
  expect(messages).toMatchObject([
    { text: " \uFEFFfirst\uFEFF ", sendId: "reused" },
    { text: "second" },
    { text: " second ", sendId: "reused" },
  ]);
  expect(messages[1]).not.toHaveProperty("promptProvenance");
});

test("C-API-70 two unresolved sends with the same text stay native", async () => {
  const { session, messages, trySubmit, paint } = await setup();
  await session.sendMessage(" one ", { sendId: "first" });
  await paint();
  await session.sendGuidance("one", { sendId: "second" });
  await trySubmit("one");
  expect(messages).toMatchObject([{ text: "one" }]);
  for (const field of ["sendId", "nativePrompt", "promptProvenance"])
    expect(messages[0]).not.toHaveProperty(field);
});

test("C-API-70 a cancelled paste allows a matching successor after verified cleanup", async () => {
  const { session, messages, pty, trySubmit, paint } = await setup();
  const abort = new AbortController();
  const write = pty.write.bind(pty);
  vi.spyOn(pty, "write").mockImplementation((data) => {
    write(data);
    if (typeof data === "string" && data.startsWith("\x1b[200~") && !abort.signal.aborted) {
      abort.abort(new Error("cancelled before Enter"));
    }
    if (data === composerClearKeys) void paint();
  });
  await expect(
    session.sendMessage(" one ", cancellableSubmission({ sendId: "discard" }, abort.signal)),
  ).rejects.toThrow("cancelled before Enter");
  expect(pty.writes).toEqual(["\x1b[200~ one \x1b[201~", composerClearKeys]);
  await session.sendMessage(" one ", { sendId: "successor" });
  await trySubmit("one");
  expect(messages).toMatchObject([{ text: " one ", sendId: "successor" }]);
});
