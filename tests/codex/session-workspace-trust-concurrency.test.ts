/** Verify that Codex list reads, event dispatch, and individual late replays use separate proof. */

import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, assert, expect, test, vi } from "vitest";
import { CodexWorkspaceTrustDiscovery } from "../../src/codex/workspace-trust/discovery.ts";
import type { ElwoodDialogEvent, ElwoodDialogRequest } from "../../src/index.ts";
import { resetFakes, tempDir } from "./helpers.ts";
import {
  interceptWorkspaceLookup,
  menu,
  menuWithQuitSelected,
  proofPause,
  setup,
} from "./workspace-trust-discovery-fixture.ts";

vi.mock("node:fs/promises", { spy: true });
afterEach(() => {
  vi.restoreAllMocks();
  resetFakes();
});

async function holdGitLookup(cwd: string, fail = false) {
  const held = proofPause();
  const finished = Promise.withResolvers<void>();
  await interceptWorkspaceLookup(cwd, async (index) => {
    if (index > 0) return;
    await held.wait();
    finished.resolve();
    if (fail) throw new Error("workspace lookup failed");
  });
  return { ...held, finished: finished.promise };
}

test("C-ATTN-08 a blocked event proof neither delays a list nor supplies its evidence", async () => {
  const { cwd, session, render } = await setup();
  const held = await holdGitLookup(cwd);
  const observed = vi.fn((event: ElwoodDialogEvent) => {
    if (event.phase === "raised") void session.terminal.writeOutput("host output");
  });
  session.on("dialog", observed);
  try {
    await render(menu(cwd));
    await held.began;
    const [request] = await session.listDialogs();
    expect(request).toBeDefined();
    expect(observed).not.toHaveBeenCalled();
    held.release();
    await expect
      .poll(() => observed.mock.calls.map(([event]) => event.phase))
      .toEqual(["raised", "closed"]);
    expect(await session.listDialogs()).toEqual([]);
  } finally {
    held.release();
    await session.teardown();
  }
});

test("C-ATTN-08 an obsolete event lookup cannot retire a newer listed request", async () => {
  const { cwd, session, render } = await setup();
  const held = await holdGitLookup(cwd, true);
  const observed = vi.fn();
  const checks = vi.spyOn(CodexWorkspaceTrustDiscovery.prototype, "readForPublication");
  session.on("dialog", observed);
  try {
    await render(menu(cwd));
    await held.began;
    await render(menu(cwd, "folder-access-no-hook-bypass"));
    expect(checks.mock.calls[0]?.[1].aborted).toBe(true);
    const [request] = await session.listDialogs();
    expect(request?.choices[1]?.label).toBe("Back to Agent Command Center");
    await expect.poll(() => observed.mock.calls).toEqual([[{ phase: "raised", request }]]);
    held.release();
    await held.finished;
    await setImmediate();
    expect(await session.listDialogs()).toEqual([request]);
  } finally {
    held.release();
    await session.teardown();
  }
});

test("C-ATTN-08 verifies each late replay after earlier listeners run", async () => {
  const { cwd, session, render } = await setup();
  const original = join(tempDir(), "original");
  const announced = vi.fn();
  session.on("dialog", announced);
  try {
    await render(menu(cwd));
    await expect.poll(() => announced.mock.calls.length).toBe(1);
    const first = vi.fn((event: ElwoodDialogEvent) => {
      if (event.phase !== "raised") return;
      renameSync(cwd, original);
      mkdirSync(cwd);
    });
    const second = vi.fn<(event: ElwoodDialogEvent) => void>();
    session.on("dialog", first);
    session.on("dialog", second);
    await expect.poll(() => first.mock.calls.map(([event]) => event.phase)).toContain("raised");
    await expect.poll(() => second.mock.calls.map(([event]) => event.phase)).toEqual(["closed"]);
    expect(await session.listDialogs()).toEqual([]);
  } finally {
    await session.teardown();
  }
});

test("C-ATTN-08 one live snapshot precedes reentrant list revalidation", async () => {
  const { cwd, session, render } = await setup();
  const original = join(tempDir(), "original");
  const listing = Promise.withResolvers<readonly ElwoodDialogRequest[]>();
  const first = vi.fn((event: ElwoodDialogEvent) => {
    if (event.phase !== "raised") return;
    renameSync(cwd, original);
    mkdirSync(cwd);
    void session.listDialogs().then(listing.resolve, listing.reject);
  });
  const second = vi.fn<(event: ElwoodDialogEvent) => void>();
  session.on("dialog", first);
  session.on("dialog", second);
  try {
    await render(menu(cwd));
    await expect.poll(() => second.mock.calls[0]?.[0].phase).toBe("raised");
    const raised = second.mock.calls[0]?.[0];
    assert.isDefined(raised);
    expect(raised).toBe(first.mock.calls[0]?.[0]);
    expect(Object.isFrozen(raised)).toBe(true);
    expect(Object.isFrozen(raised.request)).toBe(true);
    expect(await listing.promise).toEqual([]);
    await expect
      .poll(() => second.mock.lastCall?.[0])
      .toEqual({
        phase: "closed",
        reason: "unavailable",
        request: raised.request,
      });
  } finally {
    await session.teardown();
  }
});

test.each([
  "stop",
  "host output",
] as const)("C-ATTN-08 cancels a held proof for late replay after %s", async (revoke) => {
  const { cwd, session, render } = await setup();
  const live = vi.fn();
  session.on("dialog", live);
  const held = proofPause();
  try {
    await render(menu(cwd));
    await expect.poll(() => live.mock.calls.length).toBe(1);
    await interceptWorkspaceLookup(cwd, held.wait);
    const late = vi.fn<(event: ElwoodDialogEvent) => void>();
    session.on("dialog", late);
    await held.began;
    if (revoke === "stop") await session.stop();
    else await session.terminal.writeOutput(revoke);
    await expect.poll(() => late.mock.calls.map(([event]) => event.phase)).toEqual(["closed"]);
    expect(await session.listDialogs()).toEqual([]);
  } finally {
    held.release();
    await session.teardown();
  }
});

test.each([
  "listener",
  "frame",
] as const)("C-ATTN-08 rechecks a pending replay after replacement of its %s", async (changed) => {
  const { cwd, session, render } = await setup();
  const live = vi.fn();
  session.on("dialog", live);
  const held = proofPause();
  const fresh = proofPause();
  try {
    await render(menu(cwd));
    await expect.poll(() => live.mock.calls.length).toBe(1);
    await interceptWorkspaceLookup(cwd, (index) => [held, fresh][index]?.wait());
    const late = vi.fn();
    const off = session.on("dialog", late);
    await held.began;
    if (changed === "listener") {
      off();
      session.on("dialog", late);
    } else {
      await render(menuWithQuitSelected(cwd));
    }
    held.release();
    await fresh.began;
    expect(late).not.toHaveBeenCalled();
    fresh.release();
    await expect.poll(() => late.mock.calls).toEqual(live.mock.calls);
  } finally {
    held.release();
    fresh.release();
    await session.teardown();
  }
});
