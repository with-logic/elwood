/**
 * Raw caller input owns an unresolved Codex update prompt: a skip still waiting on render
 * settlement withholds its key, and no redraw is answered until a native composer clears
 * the prompt (C-CODEX-12).
 */
import { expect, test, vi } from "vitest";
import { CodexStartupPromptResponder } from "../../src/codex/startup-prompts.ts";
import { codexOptionStillSafe } from "../../src/codex/update-prompt.ts";
import { guardedNonTrustAutomationWrite } from "../../src/core/startup/barrier.ts";
import { codexComposer } from "../fixtures/trust-composer.ts";

const prompt = "Update available! 0.153.3 -> 0.153.4\n1. Update now\n2. Skip";

test("C-CODEX-12 caller input during the skip's render settlement owns the update until a composer", async () => {
  const writes: string[] = [];
  let settle = Promise.withResolvers<void>();
  let frame = prompt;
  const terminal = { sendInput: () => undefined, settled: () => settle.promise };
  const guarded = guardedNonTrustAutomationWrite(
    terminal,
    (input) => {
      writes.push(input);
    },
    () => frame,
    "codex",
    codexOptionStillSafe,
  );
  const responder = new CodexStartupPromptResponder("s1", true, undefined, undefined, () => false);
  const show = (text: string) => {
    frame = text;
    const result = responder.handle(
      text,
      () => undefined,
      () => frame,
      guarded,
    );
    responder.observeClearance(text);
    return result.outcomes;
  };
  const [skip] = show(prompt);
  expect(skip?.outcome).toMatchObject({ kind: "attempted", prompt: "update", input: "2" });
  // The caller types while the skip is parked on render settlement.
  responder.callerInput();
  writes.push("hello");
  settle.resolve();
  await expect(skip?.settled).resolves.toBe("cancelled");
  expect(writes).toEqual(["hello"]);
  // A blank frame is no clearance, so the redrawn prompt is still the caller's.
  expect(show("")).toEqual([]);
  expect(show(prompt)).toEqual([]);
  expect(writes).toEqual(["hello"]);
  // A native composer resolves it; the next appearance is a new prompt.
  expect(show(codexComposer)).toEqual([]);
  settle = Promise.withResolvers<void>();
  settle.resolve();
  const [next] = show(prompt);
  expect(next?.outcome).toMatchObject({ kind: "attempted", input: "2" });
  await vi.waitFor(() => expect(writes).toEqual(["hello", "2"]));
  show(codexComposer);
  await expect(next?.settled).resolves.toBe("answered");
});

test("C-CODEX-12 caller input with no update on screen leaves the next one to automation", async () => {
  const writes: string[] = [];
  let frame = prompt;
  const terminal = { sendInput: () => undefined, settled: () => Promise.resolve() };
  const guarded = guardedNonTrustAutomationWrite(
    terminal,
    (input) => {
      writes.push(input);
    },
    () => frame,
    "codex",
    codexOptionStillSafe,
  );
  const responder = new CodexStartupPromptResponder("s1", true, undefined, undefined, () => false);
  responder.callerInput();
  const [skip] = responder.handle(
    prompt,
    () => undefined,
    () => frame,
    guarded,
  ).outcomes;
  expect(skip?.outcome).toMatchObject({ kind: "attempted", input: "2" });
  await vi.waitFor(() => expect(writes).toEqual(["2"]));
  // A native composer settles the skip, so no retry outlives the test.
  frame = codexComposer;
  responder.handle(
    codexComposer,
    () => undefined,
    () => frame,
    guarded,
  );
  responder.observeClearance(codexComposer);
  await expect(skip?.settled).resolves.toBe("answered");
  expect(writes).toEqual(["2"]);
});
