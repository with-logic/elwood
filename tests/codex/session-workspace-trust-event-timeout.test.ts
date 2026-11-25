/** Verify ownership of Codex dialog replay deadlines (C-ATTN-08). */
import { setImmediate } from "node:timers/promises";
import { afterEach, assert, expect, test, vi } from "vitest";
import type { ElwoodDialogEvent } from "../../src/index.ts";
import { resetFakes } from "./helpers.ts";
import {
  interceptWorkspaceLookup,
  menu,
  proofPause,
  setup,
} from "./workspace-trust-discovery-fixture.ts";

vi.mock("node:fs/promises", { spy: true });
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetFakes();
});

async function startReplay<T>(
  cwd: string,
  held: ReturnType<typeof proofPause>,
  subscribe: () => T,
) {
  await interceptWorkspaceLookup(cwd, held.wait);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const subscription = subscribe();
  await held.began;
  return subscription;
}

test("C-ATTN-08 a canceled replay deadline leaves the announcement listed", async () => {
  const { cwd, session, render } = await setup();
  const live = vi.fn<(event: ElwoodDialogEvent) => void>();
  session.on("dialog", live);
  const held = proofPause();
  try {
    await render(menu(cwd));
    await expect.poll(() => live.mock.calls.length).toBe(1);
    const raised = live.mock.lastCall?.[0];
    assert.isDefined(raised);
    const off = await startReplay(cwd, held, () => session.on("dialog", vi.fn()));
    off();
    await vi.advanceTimersByTimeAsync(500);
    vi.useRealTimers();
    held.release();
    expect(await session.listDialogs()).toEqual([raised.request]);
    expect(live).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
    held.release();
    await session.teardown();
  }
});

test("C-ATTN-08 a current replay deadline closes the announcement once", async () => {
  const { cwd, session, render } = await setup();
  const live = vi.fn<(event: ElwoodDialogEvent) => void>();
  const late = vi.fn<(event: ElwoodDialogEvent) => void>();
  session.on("dialog", live);
  const held = proofPause();
  try {
    await render(menu(cwd));
    await expect.poll(() => live.mock.calls.length).toBe(1);
    const raised = live.mock.lastCall?.[0];
    assert.isDefined(raised);
    await startReplay(cwd, held, () => session.on("dialog", late));
    await vi.advanceTimersByTimeAsync(500);
    vi.useRealTimers();
    await setImmediate();
    const closed = {
      phase: "closed",
      request: raised.request,
      reason: "unavailable",
    } satisfies ElwoodDialogEvent;
    expect(live.mock.calls).toEqual([[raised], [closed]]);
    expect(late).toHaveBeenCalledExactlyOnceWith(closed);
    expect(await session.listDialogs()).toEqual([]);
  } finally {
    vi.useRealTimers();
    held.release();
    await session.teardown();
  }
});
