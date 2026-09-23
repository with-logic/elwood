/** Native Codex prompt identity acknowledges turns without changing caller text (C-API-48/40). */
import { afterEach, expect, test, vi } from "vitest";
import { codexSubmittedPrompt } from "../../src/codex/submitted-prompt.ts";
import { runTurn } from "../../src/core/simple/turn.ts";
import { activity, collect, drive } from "./simple-turn-fakes.ts";

afterEach(() => vi.useRealTimers());
const raw = "  ELWOOD_HOOK_A\u0001B\u0085C\tD\rE\r\nF\nG  ";
// Captured from native Codex 0.156.1 UserPromptSubmit and user_message, with a bogus model.
const submitted = "ELWOOD_HOOK_ABC\tD\nE\nF\nG";

test("C-API-40 Codex correlation preserves tabs while normalizing native submitted text", () => {
  expect(codexSubmittedPrompt(raw)).toBe(submitted);
  expect(codexSubmittedPrompt("x\u001b[201~y")).toBe("x[201~y");
  expect(codexSubmittedPrompt("a\tb")).not.toBe(codexSubmittedPrompt("a b"));
});

test.each([
  "hook",
  "activity",
])("C-API-48 native %s identity prevents duplicate replay", async (kind) => {
  vi.useFakeTimers();
  const session = drive((s) => {
    s.emit("status", { status: "running" });
    if (kind === "hook") s.emit("hook", { hook_event_name: "UserPromptSubmit", prompt: submitted });
    else s.emit("activity", activity({ kind: "user_message", text: submitted }));
    s.emit("status", { status: "ready" });
  });
  const send = vi.spyOn(session, "sendMessage");
  const result = collect(
    runTurn(session, raw, {
      submittedPrompt: codexSubmittedPrompt(raw),
      fallbackQuietMs: 10,
    }).events,
  ).catch((error: unknown) => error);
  await vi.runAllTimersAsync();
  expect(await result).toEqual([]);
  expect(send).toHaveBeenCalledExactlyOnceWith(raw, undefined);
});

test.each([
  "hook",
  "activity",
])("C-API-48 %s with a space instead of a tab cannot acknowledge", async (kind) => {
  vi.useFakeTimers();
  const session = drive((s) => {
    s.emit("status", { status: "running" });
    const wrong = submitted.replace("\t", " ");
    if (kind === "hook") s.emit("hook", { hook_event_name: "UserPromptSubmit", prompt: wrong });
    else s.emit("activity", activity({ kind: "user_message", text: wrong }));
    s.emit("status", { status: "ready" });
  });
  const result = collect(
    runTurn(session, raw, {
      submittedPrompt: codexSubmittedPrompt(raw),
      fallbackQuietMs: 10,
      drainMs: 1,
    }).events,
  ).catch((error: unknown) => error);
  await vi.runAllTimersAsync();
  expect(await result).toMatchObject({ code: "wait_timeout" });
  expect(session.submissions).toBe(3);
});

test("C-API-48 generic acceptance retains exact caller-text matching", async () => {
  vi.useFakeTimers();
  const session = drive((s) => {
    s.emit("status", { status: "running" });
    s.emit("hook", { hook_event_name: "UserPromptSubmit", prompt: submitted });
    s.emit("status", { status: "ready" });
  });
  const result = collect(runTurn(session, raw, { fallbackQuietMs: 10, drainMs: 1 }).events).catch(
    (error: unknown) => error,
  );
  await vi.runAllTimersAsync();
  expect(await result).toMatchObject({ code: "wait_timeout" });
  expect(session.submissions).toBe(3);
});
