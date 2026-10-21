/** Question waits react only to rendering, resize, or cancellation and remove subscriptions (PRD §4). */
import { afterEach, expect, test, vi } from "vitest";
import { disposeInputHarnesses, inputHarness as setup } from "./input-helpers.ts";

afterEach(async () => {
  await disposeInputHarnesses();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function trackResize(h: ReturnType<typeof setup>) {
  const subscribe = h.terminal.xterm.onResize.bind(h.terminal.xterm);
  const disposals: ReturnType<typeof vi.fn>[] = [];
  // xterm implements this typed event method as a getter; replace only this disposable fixture.
  const onResize: typeof h.terminal.xterm.onResize = (listener) => {
    const subscription = subscribe(listener);
    const dispose = vi.fn(() => subscription.dispose());
    disposals.push(dispose);
    return { dispose };
  };
  Object.defineProperty(h.terminal.xterm, "onResize", { value: onResize, configurable: true });
  return disposals;
}

test("an idle wait performs no repeated frame checks and wakes on resize", async () => {
  const entered = Promise.withResolvers<void>();
  let checks = 0;
  const h = setup();
  await h.terminal.writeOutput("question");
  const disposals = trackResize(h);
  vi.useFakeTimers();
  const pending = h.track(
    h.io.wait((frame) => {
      checks++;
      entered.resolve();
      return frame.cols === 141;
    }),
  );
  await entered.promise;
  await vi.advanceTimersByTimeAsync(1_000);
  expect(checks).toBe(1);
  h.terminal.resize({ cols: 141, rows: 45 });
  await pending;
  expect(checks).toBe(2);
  expect(disposals).toHaveLength(1);
  for (const dispose of disposals) expect(dispose).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test("aborting an idle wait releases resize subscriptions", async () => {
  const entered = Promise.withResolvers<void>();
  const h = setup();
  await h.terminal.writeOutput("question");
  const disposals = trackResize(h);
  const pending = h.track(
    h.io.wait(() => {
      entered.resolve();
      return false;
    }),
  );
  const failed = pending.catch((error: unknown) => error);
  await entered.promise;
  h.operation.abort();
  expect(await failed).toBe(h.io.signal.reason);
  expect(disposals).toHaveLength(1);
  for (const dispose of disposals) expect(dispose).toHaveBeenCalledOnce();
});

test("a predicate that revokes synchronously cannot leave a pre-aborted render wait subscribed", async () => {
  const h = setup();
  await h.terminal.writeOutput("question");
  const disposals = trackResize(h);
  await expect(
    h.track(
      h.io.wait(() => {
        h.operation.abort();
        return false;
      }),
    ),
  ).rejects.toMatchObject({
    code: "question_answer_failed",
  });
  expect(disposals).toHaveLength(1);
  for (const dispose of disposals) expect(dispose).toHaveBeenCalledOnce();
});

test("fixture disposal settles pending native I/O before disposing the terminal", async () => {
  const entered = Promise.withResolvers<void>();
  const h = setup();
  await h.terminal.writeOutput("question");
  const pending = h
    .track(
      h.io.wait(() => {
        entered.resolve();
        return false;
      }),
    )
    .catch(() => "failed");
  await entered.promise;
  await disposeInputHarnesses();
  expect(await pending).toBe("failed");
});
