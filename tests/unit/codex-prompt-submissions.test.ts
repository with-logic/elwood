/** Exercise scoped Codex submission evidence and its bounds (PRD §5.4, C-API-70). */
import { expect, onTestFinished, test, vi } from "vitest";
import { normalizeCodexPastedPayload } from "../../src/codex/input-text.ts";
import { writeQueuedInput } from "../../src/core/input/index.ts";
import type { SubmitKind } from "../../src/runtime/session/image-attach.ts";
import { PromptSubmissions } from "../../src/runtime/session/prompt-submissions.ts";
import { SessionInputOwnership } from "../../src/runtime/session/session-input.ts";
import { setupTerminalPty } from "../helpers/terminal-pty.ts";

function fixture() {
  const writes: (string | Uint8Array)[] = [];
  const { terminal, emit } = setupTerminalPty(undefined, (data) => writes.push(data));
  const input = new SessionInputOwnership(terminal);
  const closing = new AbortController();
  const prompts = new PromptSubmissions(input.caller, closing.signal, normalizeCodexPastedPayload);
  const empty = {};
  const guard = prompts.guard({
    prepareStaged: () => () => true,
    emptyFrame: () => (writes.length === 0 ? empty : undefined),
  });
  onTestFinished(() => {
    closing.abort();
    terminal.dispose();
  });
  const paste = async (
    text: string,
    options?: { readonly sendId: string },
    kind: SubmitKind = "message",
  ) => {
    const scope = guard.observePaste?.(text, empty);
    if (!scope) throw new Error("Expected an eligible paste.");
    const framed = `\x1b[200~${text}\x1b[201~`;
    await scope(framed, () => input.automated.sendInput(framed));
    if (options) prompts.captureCaller(text, options, undefined, kind)(text);
    await scope("\r", () => input.automated.sendInput("\r"));
  };
  return { input, prompts, terminal, writes, guard, empty, paste, emit };
}

test("C-API-70 a forwarded recovery Enter can match when the first Enter was suppressed", async () => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const { input, prompts, terminal, writes, guard, emit } = fixture();
  const sent = writeQueuedInput(
    input.automated,
    " text ",
    "pasted_input",
    guard,
    undefined,
    undefined,
    undefined,
    prompts.captureCaller(" text ", { sendId: "recovery" }, undefined, "message"),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(writes).toEqual(["\x1b[200~ text \x1b[201~"]);
  terminal.xterm.options.disableStdin = true;
  await vi.advanceTimersByTimeAsync(300);
  terminal.xterm.options.disableStdin = false;
  emit("\x1b[5n");
  const response = terminal.settled();
  await vi.advanceTimersByTimeAsync(1);
  await response;
  await sent;
  expect(writes).toEqual(["\x1b[200~ text \x1b[201~", "\x1b[0n"]);
  expect(prompts.observeNativeSubmit({ turnId: "early", nativePrompt: "text" })).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(writes).toEqual(["\x1b[200~ text \x1b[201~", "\x1b[0n", "\r"]);
  expect(prompts.observeNativeSubmit({ turnId: "native", nativePrompt: "text" })).toMatchObject({
    text: " text ",
    sendId: "recovery",
  });
});

test("C-API-70 native history keeps the exact bound and omits invalid caller IDs", async () => {
  const { empty, guard, paste, prompts } = fixture();
  for (let i = 0; i < 1_023; i += 1) {
    expect(
      prompts.observeNativeSubmit({ turnId: `native-${i}`, nativePrompt: undefined }),
    ).toBeUndefined();
  }
  await paste("one", { sendId: "x".repeat(1_025) });
  const last = prompts.observeNativeSubmit({ turnId: "last", nativePrompt: "one" });
  expect(last).toMatchObject({ text: "one", nativePrompt: "one" });
  expect(last).not.toHaveProperty("sendId");
  await paste("two");
  expect(prompts.observeNativeSubmit({ turnId: "overflow", nativePrompt: "two" })).toBeUndefined();
  expect(guard.observePaste?.("three", empty)).toBeUndefined();
});

test.each([
  ["unmatched text", "one", "two", "native"],
  ["missing text", "one", undefined, "native"],
  ["blank text", " ", "", "native"],
  ["missing native ID", "one", "one", ""],
  ["overlong native ID", "one", "one", "x".repeat(129)],
])("C-API-70 %s does not establish association", async (_label, text, prompt, id) => {
  const { guard, empty, paste, prompts } = fixture();
  await paste(text, { sendId: "candidate" });
  expect(prompts.observeNativeSubmit({ turnId: id, nativePrompt: prompt })).toBeUndefined();
  expect(guard.observePaste?.("other", empty)).toBeUndefined();
});

test("C-API-70 native consumption can retire a loop prompt without attributing API origin", async () => {
  const { guard, empty, paste, prompts } = fixture();
  await paste("loop");
  prompts.cleared();
  expect(
    prompts.observeNativeSubmit({ turnId: "native-loop", nativePrompt: "loop" }),
  ).toBeUndefined();
  expect(guard.observePaste?.("other", empty)).toBeDefined();
});

test("C-API-70 host render mutations revoke prompt association", async () => {
  const { guard, empty, terminal } = fixture();
  await terminal.writeOutput("Host overlay");
  expect(guard.observePaste?.("text", empty)).toBeUndefined();
});

test("C-API-70 a large prompt forwards without attribution", async () => {
  const { paste, prompts, writes } = fixture();
  const text = `long\n${"x".repeat(65_536)}`;
  await paste(text, { sendId: "large" });
  expect(writes).toEqual([`\x1b[200~${text}\x1b[201~`, "\r"]);
  expect(prompts.observeNativeSubmit({ turnId: "native", nativePrompt: text })).toBeUndefined();
});

test("C-API-70 a mismatched forwarding inside the scope cannot stand in for Enter", async () => {
  const { guard, empty, input, prompts } = fixture();
  const scope = guard.observePaste?.("text", empty);
  await scope?.("\x1b[200~text\x1b[201~", () =>
    input.automated.sendInput("\x1b[200~text\x1b[201~"),
  );
  prompts.captureCaller("text", { sendId: "candidate" }, undefined, "message")("text");
  await scope?.("\r", () => input.automated.sendInput("unrelated input"));
  expect(prompts.observeNativeSubmit({ turnId: "native", nativePrompt: "text" })).toBeUndefined();
});

test("C-API-70 a command only revokes when an earlier paste is unresolved", async () => {
  const { guard, empty, paste, prompts } = fixture();
  guard.beforeCommand?.();
  await paste("first", { sendId: "after-command" });
  expect(
    prompts.observeNativeSubmit({ turnId: "first-turn", nativePrompt: "first" }),
  ).toHaveProperty("sendId", "after-command");
  await paste("unresolved");
  guard.beforeCommand?.();
  expect(guard.observePaste?.("later", empty)).toBeUndefined();
});
