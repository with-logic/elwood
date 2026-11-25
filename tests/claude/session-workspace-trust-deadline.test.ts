/** Keep optional Claude workspace proof off the event loop and discard stale native frames (C-ATTN-08). */
import { realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { afterEach, assert, expect, test, vi } from "vitest";
import { startClaude } from "../../src/index.ts";
import { holdGitLookup } from "../helpers/hold-git-lookup.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";
import { trustFrame } from "./workspace-trust-discovery-fixture.ts";

vi.mock("node:fs/promises", { spy: true });
afterEach(() => {
  vi.mocked(fs.lstat).mockReset();
  vi.restoreAllMocks();
  resetFakes();
});

test("C-ATTN-08 stalled Claude revalidation retires the request for that launch", async () => {
  installFakes();
  const cwd = realpathSync(tempDir());
  const session = await startClaude({ cwd });
  const events = vi.fn();
  session.on("dialog", events);
  const render = async () => {
    ptys[0]!.emitData(trustFrame(cwd));
    await session.terminal.settled();
  };
  await render();
  const [request] = await session.listDialogs();
  assert.isDefined(request);
  const held = await holdGitLookup(fs.lstat, cwd, "all");
  try {
    const reading = session.listDialogs();
    await held.began;
    expect(await reading).toEqual([]);
    expect(events.mock.calls).toEqual([
      [{ phase: "raised", request }],
      [{ phase: "closed", reason: "unavailable", request }],
    ]);
    held.release();
    await render();
    expect(await session.listDialogs()).toEqual([]);
    expect(events).toHaveBeenCalledTimes(2);
  } finally {
    held.release();
    await session.teardown();
  }
});

test("C-ATTN-08 Claude rechecks a same-menu repaint after an older proof completes", async () => {
  installFakes();
  const cwd = realpathSync(tempDir());
  const session = await startClaude({ cwd });
  const live = vi.fn();
  session.on("dialog", live);
  const render = async (data: string) => {
    ptys[0]!.emitData(data);
    await session.terminal.settled();
  };
  const menu = trustFrame(cwd);
  await render(menu);
  const [request] = await session.listDialogs();
  assert.isDefined(request);
  await expect.poll(() => live.mock.calls).toEqual([[{ phase: "raised", request }]]);
  const held = await holdGitLookup(fs.lstat, cwd, "all");
  const late = vi.fn();
  session.on("dialog", late);
  try {
    await held.began;
    await render(menu.replace("❯ No", "  No").replace("   Yes", " ❯ Yes"));
    expect(late).not.toHaveBeenCalled();
    held.release();
    await expect.poll(() => late.mock.calls).toEqual([[{ phase: "raised", request }]]);
  } finally {
    held.release();
    await session.teardown();
  }
});

test("C-ATTN-08 Claude replay checks the request again after its proof completes", async () => {
  installFakes();
  const cwd = realpathSync(tempDir());
  const session = await startClaude({ cwd });
  const live = vi.fn();
  session.on("dialog", live);
  ptys[0]!.emitData(trustFrame(cwd));
  await session.terminal.settled();
  const [request] = await session.listDialogs();
  assert.isDefined(request);
  await expect.poll(() => live.mock.calls).toEqual([[{ phase: "raised", request }]]);
  const held = await holdGitLookup(fs.lstat, cwd, "all");
  const late = vi.fn();
  session.on("dialog", (event) => {
    if (event.phase === "closed") session.off("dialog", late);
  });
  session.on("dialog", late);
  const closed = Promise.withResolvers<void>();
  session.on("dialog", (event) => {
    if (event.phase === "closed") closed.resolve();
  });
  try {
    await held.began;
    await closed.promise;
    expect(await session.listDialogs()).toEqual([]);
    expect(late).not.toHaveBeenCalled();
  } finally {
    held.release();
    await session.teardown();
  }
});

test.each([
  "none",
  "queued",
  "pending",
] as const)("C-ATTN-08 a Claude event probe without observers cannot retire list evidence (%s)", async (detached) => {
  installFakes();
  const cwd = realpathSync(tempDir());
  const session = await startClaude({ cwd });
  const held = await holdGitLookup(fs.lstat, cwd, "all");
  try {
    ptys[0]!.emitData(trustFrame(cwd));
    await session.terminal.settled();
    if (detached !== "none") {
      const off = session.on("dialog", vi.fn());
      if (detached === "pending") await held.began;
      off();
    }
    await setTimeout(550);
    if (detached !== "pending") {
      const marker = join(cwd, ".git");
      expect(vi.mocked(fs.lstat).mock.calls.filter(([path]) => path === marker)).toEqual([]);
    }
    held.release();
    expect(await session.listDialogs()).toHaveLength(1);
  } finally {
    held.release();
    await session.teardown();
  }
});

test("C-ATTN-08 raw Claude input after takeover does not start another scope check", async () => {
  installFakes();
  const cwd = realpathSync(tempDir());
  const session = await startClaude({ cwd, autotrust: true });
  const observed = vi.fn();
  session.on("dialog", observed);
  try {
    ptys[0]!.emitData(trustFrame(cwd));
    await session.terminal.settled();
    await session.sendKeys("x");
    await expect.poll(() => observed.mock.calls.length).toBe(1);
    const proofCount = vi.mocked(fs.stat).mock.calls.length;
    await session.sendKeys("y");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(vi.mocked(fs.stat)).toHaveBeenCalledTimes(proofCount);
    expect(observed).toHaveBeenCalledTimes(1);
  } finally {
    await session.teardown();
  }
});
