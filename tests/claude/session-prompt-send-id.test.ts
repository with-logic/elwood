/** Exercise matched Claude API prompts through the authenticated hook and real PTY seam (C-API-71). */
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { withSubmissionAttempt } from "../../src/core/simple/submission-context.ts";
import { claudePasteEnvelope } from "../fixtures/claude-paste.ts";
import { claudeComposer, claudeTty } from "../fixtures/trust-composer.ts";
import { ptys, resetFakes } from "./helpers.ts";
import { startActivitySession } from "./session-user-activity-helpers.ts";

afterEach(resetFakes);
const wrap = (body: string) => claudePasteEnvelope(body, "0e08");

async function setup() {
  const { session, hook, events, append } = await startActivitySession();
  onTestFinished(() => session.teardown());
  const pty = ptys.at(-1)!;
  const paint = async () => {
    pty.emitData(`\x1b[2J\x1b[H${claudeTty(claudeComposer)}`);
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

test("C-API-71 ergonomic submission observation does not opt into API provenance", async () => {
  const { session, submit, messages } = await setup();
  const beforeEnter = vi.fn();
  await withSubmissionAttempt(session, { beforeEnter }, () =>
    session.sendPrompt("caption ", { sendId: "caller" }),
  );
  expect(beforeEnter).toHaveBeenCalledWith("caption ");
  await submit(wrap("caption"), "native");
  expect(messages()[0]).toMatchObject({ text: "caption", promptProvenance: { origin: "unknown" } });
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
  expect(messages().flatMap(({ sendId }) => sendId ?? [])).toEqual(["one"]);
});
