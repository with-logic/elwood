/** Guidance claims its caller ID through a hook under the running turn's ID (PRD §5.4, C-API-70, C-API-71). */
import { expect, onTestFinished, test } from "vitest";
import { normalizeCodexPastedPayload } from "../../src/codex/input-text.ts";
import type { SubmitKind } from "../../src/runtime/session/image-attach.ts";
import { PromptSubmissions } from "../../src/runtime/session/prompt-submissions.ts";
import { SessionInputOwnership } from "../../src/runtime/session/session-input.ts";
import { setupTerminalPty } from "../helpers/terminal-pty.ts";

/** A ledger whose running turn `running` already started; `working` is the only empty proof. */
function runningTurn() {
  const { terminal } = setupTerminalPty(undefined, () => undefined);
  const input = new SessionInputOwnership(terminal);
  const closing = new AbortController();
  const prompts = new PromptSubmissions(input.caller, closing.signal, normalizeCodexPastedPayload);
  const working = {};
  const guard = prompts.guard({
    prepareStaged: () => () => true,
    workingEmptyFrame: () => working,
  });
  onTestFinished(() => {
    closing.abort();
    terminal.dispose();
  });
  const write = async (text: string, kind: SubmitKind, sendId: string) => {
    const scope = guard.observePaste?.(text, undefined);
    if (!scope) return false;
    const framed = `\x1b[200~${text}\x1b[201~`;
    await scope(framed, () => input.automated.sendInput(framed));
    prompts.captureCaller(text, { sendId }, undefined, kind)(text);
    await scope("\r", () => input.automated.sendInput("\r"));
    return true;
  };
  const hook = (nativePrompt: string, turnId = "running") =>
    prompts.observeNativeSubmit({ turnId, nativePrompt });
  hook("the prompt that started the turn");
  return { write, hook, eligible: () => guard.observePaste?.("next", undefined) !== undefined };
}

test("C-API-70 C-API-71 guidance claims the hook under the running turn's ID once", async () => {
  const { write, hook, eligible } = runningTurn();
  await write(" note ", "guidance", "guidance-1");
  expect(hook("note")).toMatchObject({
    text: " note ",
    sendId: "guidance-1",
    nativePrompt: "note",
    turnId: "running",
    promptProvenance: { origin: "api", input: "pasted" },
  });
  expect(hook("note")).toBeUndefined();
  await write(" note ", "guidance", "guidance-2");
  expect(hook("note")).toHaveProperty("sendId", "guidance-2");
  expect(eligible()).toBe(true);
});

test.each([
  "message",
  "prompt",
] as const)("C-API-70 C-API-71 a %s cannot claim a hook under an existing ID", async (kind) => {
  const { write, hook, eligible } = runningTurn();
  await write("note", kind, "caller");
  expect(hook("note")).toBeUndefined();
  // The send stays unresolved, so a later paste ends tracking.
  expect(eligible()).toBe(false);
});

test("C-API-70 C-API-71 a mismatched hook under the running turn's ID ends tracking", async () => {
  const { write, hook, eligible } = runningTurn();
  await write("note", "guidance", "caller");
  expect(hook("Edited. note")).toBeUndefined();
  expect(hook("note")).toBeUndefined();
  expect(eligible()).toBe(false);
});

test("C-API-70 C-API-71 identical guidance written before either hook claims neither", async () => {
  const { write, hook } = runningTurn();
  await write("note", "guidance", "first");
  expect(await write("note", "guidance", "second")).toBe(false);
  expect(hook("note")).toBeUndefined();
  expect(hook("note")).toBeUndefined();
});
