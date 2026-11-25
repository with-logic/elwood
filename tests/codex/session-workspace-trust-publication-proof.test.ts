/** Verify when evidence can commit or dispatch a Codex trust event (C-ATTN-08). */
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { CodexWorkspaceTrustDiscovery } from "../../src/codex/workspace-trust/discovery.ts";
import { resetFakes } from "./helpers.ts";
import {
  afterPublicationProof,
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

test("C-ATTN-08 an older positive lookup cannot restore disproved evidence on the same frame", async () => {
  const { cwd, session, render } = await setup();
  const held = proofPause();
  await interceptWorkspaceLookup(cwd, (index) => {
    if (index === 1) throw new Error("workspace evidence unavailable for list");
    return index === 0 ? held.wait() : undefined;
  });
  const observed = vi.fn();
  const complete = afterPublicationProof(() => {});
  session.on("dialog", observed);
  try {
    await render(menu(cwd));
    await held.began;
    expect(await session.listDialogs()).toEqual([]);
    held.release();
    await complete;
    await setImmediate();
    expect(observed).not.toHaveBeenCalled();
  } finally {
    held.release();
    await session.teardown();
  }
});

test("C-ATTN-08 losing the last listener after proof leaves no announcement to retire", async () => {
  const { cwd, session, render } = await setup();
  const off = session.on("dialog", vi.fn());
  const complete = afterPublicationProof(off);
  try {
    await render(menu(cwd));
    await complete;
    await setImmediate();
    const observed = vi.fn();
    session.on("dialog", observed);
    await render("an unsupported native screen");
    await setImmediate();
    expect(observed).not.toHaveBeenCalled();
  } finally {
    await session.teardown();
  }
});

test("C-ATTN-08 a failed, canceled publication does not revoke independent listing", async () => {
  const { cwd, session, render } = await setup();
  const observed = vi.fn();
  const off = session.on("dialog", observed);
  const complete = afterPublicationProof(() => {
    off();
    throw new Error("late publication failure");
  });
  try {
    await render(menu(cwd));
    await complete;
    await setImmediate();
    expect(await session.listDialogs()).toHaveLength(1);
    expect(observed).not.toHaveBeenCalled();
  } finally {
    await session.teardown();
  }
});

test("C-ATTN-08 removing the current replay listener still verifies the next queued listener", async () => {
  const { cwd, session, render } = await setup();
  const live = vi.fn();
  session.on("dialog", live);
  const held = proofPause();
  try {
    await render(menu(cwd));
    await expect.poll(() => live.mock.calls.length).toBe(1);
    await interceptWorkspaceLookup(cwd, (index) => (index === 0 ? held.wait() : undefined));
    const off = session.on("dialog", vi.fn());
    const remaining = vi.fn();
    session.on("dialog", remaining);
    await held.began;
    off();
    await expect.poll(() => remaining.mock.calls).toEqual(live.mock.calls);
  } finally {
    held.release();
    await session.teardown();
  }
});

test("C-ATTN-08 saturating old event lookups coalesces the latest candidate until one settles", async () => {
  const { cwd, session, render } = await setup();
  const held = [proofPause(), proofPause()] as const;
  const [first, second] = held;
  const observed = vi.fn();
  const started = vi.spyOn(CodexWorkspaceTrustDiscovery.prototype, "readForPublication");
  session.on("dialog", observed);
  try {
    await interceptWorkspaceLookup(cwd, (index) => held[index]?.wait());
    await render(menu(cwd));
    await first.began;
    await render(menu(cwd, "folder-access-no-hook-bypass"));
    await second.began;
    await render(menuWithQuitSelected(cwd));
    await setImmediate();
    expect(started).toHaveBeenCalledTimes(2);
    expect(observed).not.toHaveBeenCalled();
    first.release();
    await expect
      .poll(() => observed.mock.calls)
      .toEqual([
        [
          {
            phase: "raised",
            request: expect.objectContaining({
              choices: [
                expect.objectContaining({ label: "Trust and continue" }),
                expect.objectContaining({ label: "Quit" }),
              ],
            }),
          },
        ],
      ]);
  } finally {
    first.release();
    second.release();
    await session.teardown();
  }
});

test("C-ATTN-08 a plain close does not retry the same failed evidence", async () => {
  const { cwd, session, render } = await setup();
  const events = vi.fn();
  session.on("dialog", events);
  try {
    await render(menu(cwd));
    await expect.poll(() => events.mock.calls.length).toBe(1);
    const checks = vi.spyOn(CodexWorkspaceTrustDiscovery.prototype, "readForPublication");
    await interceptWorkspaceLookup(cwd, () => {
      throw new Error("workspace evidence unavailable");
    });
    session.on("dialog", vi.fn());
    await expect
      .poll(() => events.mock.lastCall?.[0])
      .toMatchObject({
        phase: "closed",
        reason: "unavailable",
      });
    expect(checks).toHaveBeenCalledOnce();
  } finally {
    await session.teardown();
  }
});
