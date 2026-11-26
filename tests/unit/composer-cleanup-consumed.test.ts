/**
 * A cancelled awaited draft whose writer already saw the native agent take it leaves an empty
 * composer, where clear keys repaint nothing. Cleanup releases it on that proof instead of
 * waiting for a repaint, and clears with keys whenever the proof is absent (C-API-56).
 */
import { afterEach, expect, test, vi } from "vitest";
import {
  ComposerCleanup,
  enteredComposer,
  requestComposerCleanup,
  stageComposer,
} from "../../src/core/input/composer-cleanup.ts";

afterEach(() => vi.useRealTimers());

const clearKeys = "\u0015\u000b";

/** An owner whose composer stays on one empty frame, so a clear key repaints nothing. */
function setup() {
  vi.useFakeTimers();
  let held = false;
  const terminal = { sendInput: vi.fn(), settled: () => Promise.resolve() };
  const lifetime = new AbortController();
  const onCleared = vi.fn();
  const frame = {};
  const owner = new ComposerCleanup(
    terminal,
    () => held,
    lifetime.signal,
    () => lifetime.signal,
    () => frame,
    () => () => false,
    onCleared,
  );
  /** A failed awaited write after its Enter, deferring with the writer's own proof. */
  const fail = (consumed: (() => boolean) | undefined) =>
    owner
      .run(async () => {
        stageComposer(terminal);
        enteredComposer(terminal);
        await requestComposerCleanup(terminal, () => held, consumed);
        throw new Error("cancelled at acceptance");
      }, lifetime.signal)
      .catch((error: unknown) => error);
  const hold = (value: boolean) => {
    held = value;
  };
  return { terminal, owner, lifetime, onCleared, fail, hold };
}

test("C-API-56 a draft its writer saw taken is released without clear keys", async () => {
  const { terminal, owner, lifetime, onCleared, fail } = setup();
  expect(await fail(() => true)).toMatchObject({ message: "cancelled at acceptance" });
  const work = vi.fn(async () => {});
  await owner.run(work, lifetime.signal);
  expect(work).toHaveBeenCalledOnce();
  expect(terminal.sendInput).not.toHaveBeenCalled();
  expect(onCleared).toHaveBeenCalledOnce();
});

test("C-ATTN-10 C-API-56 a successor releases a taken draft once the hold that kept it ends", async () => {
  const { terminal, owner, lifetime, onCleared, fail, hold } = setup();
  hold(true);
  await fail(() => true);
  expect(onCleared).not.toHaveBeenCalled();
  const work = vi.fn(async () => {});
  const successor = owner.run(work, lifetime.signal);
  await vi.advanceTimersByTimeAsync(200);
  expect(work).not.toHaveBeenCalled();
  hold(false);
  await vi.advanceTimersByTimeAsync(50);
  await successor;
  expect(work).toHaveBeenCalledOnce();
  expect(terminal.sendInput).not.toHaveBeenCalled();
  expect(onCleared).toHaveBeenCalledOnce();
});

test.each([
  { proof: "no proof", consumed: undefined },
  { proof: "proof that fails", consumed: () => false },
])("C-API-56 a draft with $proof still needs observed clear keys", async ({ consumed }) => {
  const { terminal, owner, lifetime, onCleared, fail } = setup();
  const failed = fail(consumed);
  await vi.advanceTimersByTimeAsync(1_001);
  await failed;
  expect(terminal.sendInput).toHaveBeenCalledExactlyOnceWith(clearKeys);
  const work = vi.fn(async () => {});
  const successor = expect(owner.run(work, lifetime.signal)).rejects.toMatchObject({
    code: "wait_timeout",
    message: "Could not clear the staged composer draft.",
  });
  await vi.advanceTimersByTimeAsync(1_001);
  await successor;
  expect(work).not.toHaveBeenCalled();
  expect(onCleared).not.toHaveBeenCalled();
});
