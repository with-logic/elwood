/** Exercise matched Claude API prompts through authenticated bridge hooks and FakePty writes (C-API-71). */

import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, onTestFinished, test } from "vitest";
import { claudePasteEnvelope } from "../fixtures/claude-paste.ts";
import { emptyComposer } from "../fixtures/owned-turn/composer.ts";
import { ptys, resetFakes } from "./helpers.ts";
import { startActivitySession, user } from "./session-user-activity-helpers.ts";

afterEach(resetFakes);
const wrap = (body: string) => claudePasteEnvelope(body, "0e08");

async function setup() {
  const { session, hook, events, append } = await startActivitySession();
  onTestFinished(() => session.teardown());
  const pty = ptys.at(-1)!;
  const paint = async () => {
    pty.emitData(emptyComposer("claude"));
    await session.terminal.settled();
  };
  await hook({
    hook_event_name: "InstructionsLoaded",
    file_path: "/tmp/CLAUDE.md",
    memory_type: "Project",
    load_reason: "session_start",
  });
  await paint();
  return {
    session,
    hook,
    pty,
    paint,
    append,
    messages: () => events.filter((event) => event.kind === "user_message"),
    submit: (prompt: string | undefined, prompt_id?: string) =>
      hook({ hook_event_name: "UserPromptSubmit", prompt, prompt_id }),
  };
}

test.each([
  ["ordinary  ", "ordinary"],
  ["one\u0000\r\n\ttwo\n＜pasted_content>\nfour\n", wrap("one\n    two\n<\\pasted_content>\nfour")],
])("C-API-71 preserves the exact original and native prompt", async (text, nativePrompt) => {
  const { session, pty, submit, messages } = await setup();
  const raw: string[] = [];
  session.on("hook", (hook) => {
    if (hook.hook_event_name === "UserPromptSubmit") raw.push(hook.prompt);
  });
  await session.sendMessage(text, { sendId: "caller-42" });
  await submit(nativePrompt, "native-42");
  expect(messages()).toMatchObject([
    {
      turnId: "native-42",
      text,
      nativePrompt,
      sendId: "caller-42",
      promptProvenance: { origin: "api", input: "pasted" },
      raw: { prompt: nativePrompt },
    },
  ]);
  expect(raw).toEqual([nativePrompt]);
  expect(pty.writes.join("")).not.toContain("caller-42");
});

test("C-API-71 mixed terminal input keeps Claude's existing native paste presentation", async () => {
  const { session, submit, messages } = await setup();
  await session.sendMessage(" prompt ", { sendId: "caller" });
  await session.sendKeys("x");
  const nativePrompt = wrap("prompt");
  await submit(nativePrompt, "native-id");
  expect(messages()).toMatchObject([
    {
      text: "prompt",
      nativePrompt,
      promptProvenance: { origin: "unknown", input: "pasted" },
    },
  ]);
  expect(messages()[0]).not.toHaveProperty("sendId");
});

test.each([
  [undefined, "prompt"],
  ["native-id", "different"],
])("C-API-71 preserves native-only activity for a missing ID or mismatched prompt", async (id, body) => {
  const { session, submit, messages } = await setup();
  await session.sendPrompt("prompt ", { sendId: "caller" });
  const nativePrompt = wrap(body);
  await submit(nativePrompt, id);
  expect(messages()).toMatchObject([
    {
      text: body,
      nativePrompt,
      promptProvenance: { origin: "unknown", input: "pasted" },
    },
  ]);
  expect(messages()[0]).not.toHaveProperty("sendId");
});

test("C-API-71 overlapping low-level writes cannot claim either caller ID", async () => {
  const { session, paint, submit, messages } = await setup();
  await session.sendMessage(" first ", { sendId: "one" });
  await paint();
  await session.sendGuidance(" first ", { sendId: "two" });
  await submit(wrap(" first"), "native");
  expect(messages()).toMatchObject([{ text: " first", promptProvenance: { origin: "unknown" } }]);
  expect(messages()[0]).not.toHaveProperty("sendId");
});

test("C-API-71 a reused Claude prompt ID cannot claim a second caller ID", async () => {
  const { session, paint, submit, messages } = await setup();
  await session.sendMessage(" first ", { sendId: "one" });
  await submit(" first", "reused");
  await paint();
  await session.sendGuidance(" next ", { sendId: "two" });
  await submit(" next", "reused");
  await submit(" next", "distinct");
  expect(messages()).toMatchObject([
    { text: " first ", sendId: "one" },
    { text: " next ", sendId: "two" },
  ]);
});

test("C-API-71 a transcript warning cannot revoke an already matched API prompt", async () => {
  const { session, hook, messages } = await setup();
  await session.sendMessage(" original ", { sendId: "caller" });
  const transcript = join(session.cwd, "cyclic-transcript.jsonl");
  symlinkSync(transcript, transcript);
  let warned = false;
  session.on("warning", (warning) => {
    if (warning.code === "transcript_read_error") {
      warned = true;
      session.terminal.xterm.input("x");
    }
  });
  await hook({
    hook_event_name: "UserPromptSubmit",
    prompt: " original",
    prompt_id: "native",
    transcript_path: transcript,
  });
  expect(warned).toBe(true);
  expect(messages()).toMatchObject([{ text: " original ", sendId: "caller" }]);
});

test("C-API-71 textless native hooks recover transcript paste display without caller provenance", async () => {
  const { session, submit, append, messages } = await setup();
  await session.sendMessage("caption ", { sendId: "caller" });
  await submit(undefined, "recovered");
  const nativePrompt = wrap("caption");
  append(user("recovered", nativePrompt));
  await expect.poll(messages).toMatchObject([
    {
      source: "transcript",
      turnId: "recovered",
      text: "caption",
      nativePrompt,
      promptProvenance: { origin: "unknown", input: "pasted" },
    },
  ]);
  expect(messages()[0]).not.toHaveProperty("sendId");
  expect(messages()[0]).not.toHaveProperty("raw");
});

test("C-API-71 an escaped native body can fit the exact canonical limit", async () => {
  const { session, submit, messages } = await setup();
  const tag = "<pasted_content>";
  const text = tag.padEnd(65_536, "x");
  const nativeBody = text.replace("<", "<\\");
  expect(nativeBody.length).toBe(65_537);
  const nativePrompt = wrap(nativeBody);
  await session.sendMessage(text, { sendId: "at-limit" });
  await submit(nativePrompt, "limit");
  expect(messages()[0]).toHaveProperty("sendId", "at-limit");
  expect(messages()).toMatchObject([{ text, nativePrompt }]);
});

test("C-API-71 dispatching Claude login retires an unresolved API paste", async () => {
  const { session, pty, submit, messages } = await setup();
  await session.sendMessage("pending ", { sendId: "prior-send" });
  expect(pty.writes).toEqual(["\x1b[200~pending \x1b[201~", "\r"]);
  const login = session
    .login({ provideCode: () => "unused", timeoutMs: 5_000 })
    .catch((error: unknown) => error);
  try {
    await expect.poll(() => pty.writes.includes("/login")).toBe(true);
    await submit("pending", "native-id");
    expect(messages()).toMatchObject([
      { text: "pending", turnId: "native-id", raw: { prompt: "pending" } },
    ]);
    for (const field of ["sendId", "nativePrompt", "promptProvenance"])
      expect(messages()[0]).not.toHaveProperty(field);
  } finally {
    await session.kill();
    await login;
  }
});
