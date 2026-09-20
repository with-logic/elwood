/** Unavailable rendered frames withhold trust retries under the owned deadline (C-TRUST-01). */
import { afterEach, expect, test, vi } from "vitest";
import { claudeTrustClearance } from "../../src/claude/screen-table.ts";
import { TrustPromptResponder } from "../../src/core/trust/responder.ts";
import { choiceIdentity, type TrustView, trustView } from "../../src/core/trust/view.ts";
import { TrustAttempt } from "../../src/core/trust/write.ts";
import { claudeComposer, claudeTrust } from "../fixtures/trust-composer.ts";

afterEach(() => vi.useRealTimers());

function attempt() {
  const candidate = trustView(`${claudeTrust}\n1. Yes\n2. No`, "claude", claudeTrustClearance);
  if (candidate.kind !== "candidate") throw new Error("expected candidate");
  const identity = choiceIdentity(candidate);
  if (identity === undefined) throw new Error("expected safe choice");
  return { candidate, owned: new TrustAttempt(candidate, identity) };
}

test("C-TRUST-01 unavailable frames withhold first and retry writes until current evidence returns", async () => {
  vi.useFakeTimers();
  const { candidate, owned } = attempt();
  let view: TrustView | undefined;
  const write = vi.fn();
  const completion = owned
    .start(write, () => view, Date.now() + 1_000)
    .catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(200);
  expect(write).not.toHaveBeenCalled();
  view = candidate;
  await vi.advanceTimersByTimeAsync(20);
  expect(write).toHaveBeenCalledExactlyOnceWith("1\r");
  view = undefined;
  await vi.advanceTimersByTimeAsync(500);
  expect(write).toHaveBeenCalledTimes(1);
  view = { kind: "clear" };
  await vi.advanceTimersByTimeAsync(20);
  expect(await completion).toBe("answered");
  expect(vi.getTimerCount()).toBe(0);
});

test.each([
  "cancel",
  "deadline",
])("C-TRUST-01 unavailable reads settle quietly on %s", async (end) => {
  vi.useFakeTimers();
  const { owned } = attempt();
  const write = vi.fn();
  const completion = owned
    .start(write, () => undefined, Date.now() + 95)
    .catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(40);
  if (end === "cancel") owned.cancel();
  else await vi.advanceTimersByTimeAsync(55);
  expect(await completion).toBe("cancelled");
  expect(write).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test("C-TRUST-01 a replacement revealed after unavailable output never receives the old answer", async () => {
  vi.useFakeTimers();
  const { owned } = attempt();
  let view: TrustView | undefined;
  const write = vi.fn();
  const completion = owned
    .start(write, () => view, Date.now() + 1_000)
    .catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(40);
  view = { kind: "unknown" };
  await vi.advanceTimersByTimeAsync(20);
  expect(await completion).toBe("cancelled");
  expect(write).not.toHaveBeenCalled();
});

test("C-TRUST-01 output becoming unavailable at completion keeps ownership and permits a later retry", async () => {
  vi.useFakeTimers();
  const responder = new TrustPromptResponder("claude", claudeTrustClearance, true);
  const frame = `${claudeTrust}\n1. Yes\n2. No`;
  const read = vi
    .fn<() => string | undefined>()
    .mockReturnValueOnce(frame)
    .mockReturnValueOnce(claudeComposer)
    .mockReturnValueOnce(undefined);
  const write = vi.fn();
  try {
    const result = responder.handle(frame, write, read);
    expect(result?.kind).toBe("attempted");
    await vi.advanceTimersByTimeAsync(250);
    if (result?.kind === "attempted") expect(await result.settled).toBe("cancelled");
    expect(responder.inputBlocking).toBe(true);
    read.mockReturnValue(frame);
    const retry = responder.handle(frame, write, read);
    expect(retry?.kind).toBe("attempted");
    expect(write).toHaveBeenCalledTimes(2);
    read.mockReturnValue(claudeComposer);
    await vi.advanceTimersByTimeAsync(250);
    if (retry?.kind === "attempted") expect(await retry.settled).toBe("answered");
    expect(responder.inputBlocking).toBe(false);
  } finally {
    responder.dispose();
  }
});
