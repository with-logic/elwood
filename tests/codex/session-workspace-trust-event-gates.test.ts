/** Verify the ownership and subscription gates for Codex workspace trust events (C-ATTN-08). */
import { realpathSync } from "node:fs";
import { setImmediate, setTimeout } from "node:timers/promises";
import { afterEach, assert, expect, test, vi } from "vitest";
import { CodexSessionImpl } from "../../src/codex/session/instance.ts";
import { CodexWorkspaceTrustDiscovery } from "../../src/codex/workspace-trust/discovery.ts";
import { type ElwoodDialogEvent, startCodex } from "../../src/index.ts";
import { settledNativeSnapshot } from "../../src/terminal/cursor.ts";
import { codexComposer, codexTty } from "../fixtures/trust-composer.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";
import {
  afterPublicationProof,
  clear,
  interceptWorkspaceLookup,
  menu,
  menuWithQuitSelected,
  proofPause,
  setup,
} from "./workspace-trust-discovery-fixture.ts";

vi.mock("node:fs/promises", { spy: true });
vi.mock("../../src/terminal/cursor.ts", { spy: true });
afterEach(() => {
  vi.restoreAllMocks();
  resetFakes();
});

test.each([
  "never attached",
  "detached before proof",
  "detached during proof",
] as const)("C-ATTN-08 a session without listeners retains read authority (%s)", async (subscription) => {
  const { cwd, session, render } = await setup();
  const held = proofPause();
  const lookup = await interceptWorkspaceLookup(cwd, held.wait);
  const off = subscription === "never attached" ? undefined : session.on("dialog", vi.fn());
  if (subscription === "detached before proof") off?.();
  try {
    await render(menu(cwd));
    if (subscription === "detached during proof") {
      await held.began;
      off?.();
    }
    await setTimeout(550);
    if (subscription !== "detached during proof") expect(lookup.count()).toBe(0);
    held.release();
    expect(await session.listDialogs()).toHaveLength(1);
  } finally {
    held.release();
    await session.teardown();
  }
});

test("C-ATTN-08 raises a settled menu when raw input takes it over without a repaint", async () => {
  installFakes({ supportsHookTrustBypass: false });
  const cwd = realpathSync.native(tempDir());
  const session = await startCodex({ cwd, autotrust: true });
  const observed = vi.fn();
  session.on("dialog", observed);
  try {
    const pty = ptys[0];
    assert.isDefined(pty);
    pty.emitData(clear + menu(cwd));
    await session.terminal.settled();
    expect(observed).not.toHaveBeenCalled();
    await session.sendKeys("x");
    await expect
      .poll(() => observed.mock.calls)
      .toEqual([[{ phase: "raised", request: expect.objectContaining({ targetPath: cwd }) }]]);
    const checks = vi.spyOn(CodexWorkspaceTrustDiscovery.prototype, "readForPublication");
    await session.sendKeys("x");
    await setImmediate();
    expect(checks).not.toHaveBeenCalled();
  } finally {
    await session.teardown();
  }
});

test("C-ATTN-08 a failed native snapshot retires pending replay without rejection", async () => {
  const { cwd, session, render } = await setup();
  const announced = vi.fn();
  session.on("dialog", announced);
  try {
    await render(menu(cwd));
    await expect.poll(() => announced.mock.calls.length).toBe(1);
    const observed = vi.fn();
    session.terminal.xterm.options.allowProposedApi = false;
    session.on("dialog", observed);
    await expect
      .poll(() => observed.mock.calls)
      .toEqual([[{ phase: "closed", reason: "unavailable", request: expect.any(Object) }]]);
    session.terminal.xterm.options.allowProposedApi = true;
    expect(await session.listDialogs()).toHaveLength(1);
  } finally {
    session.terminal.xterm.options.allowProposedApi = true;
    await session.teardown();
  }
});

test("C-ATTN-08 a verified repaint keeps the current announcement", async () => {
  const { cwd, session, render } = await setup();
  const announced = vi.fn();
  session.on("dialog", announced);
  try {
    await render(menu(cwd));
    await expect.poll(() => announced.mock.calls.length).toBe(1);
    const repainted = afterPublicationProof(() => {});
    await render(menuWithQuitSelected(cwd));
    await repainted;
    await setImmediate();
    expect(announced).toHaveBeenCalledTimes(1);
  } finally {
    await session.teardown();
  }
});

test.each([
  "canceled",
  "current",
] as const)("C-ATTN-08 applies only the current replay timeout (%s)", async (state) => {
  const { cwd, session, render } = await setup();
  const live = vi.fn<(event: ElwoodDialogEvent) => void>();
  session.on("dialog", live);
  const held = proofPause();
  try {
    await render(menu(cwd));
    await expect.poll(() => live.mock.calls.length).toBe(1);
    const raised = live.mock.lastCall?.[0];
    assert.isDefined(raised);
    await interceptWorkspaceLookup(cwd, (index) => (index === 0 ? held.wait() : undefined));
    const late = vi.fn();
    const off = session.on("dialog", late);
    await held.began;
    if (state === "canceled") {
      off();
      await setTimeout(550);
      expect(await session.listDialogs()).toEqual([raised.request]);
      expect(live).toHaveBeenCalledTimes(1);
    } else {
      const closed = { phase: "closed", request: raised.request, reason: "unavailable" };
      await expect.poll(() => live.mock.lastCall?.[0]).toEqual(closed);
      expect(late).toHaveBeenCalledExactlyOnceWith(closed);
      expect(await session.listDialogs()).toEqual([]);
    }
  } finally {
    held.release();
    await session.teardown();
  }
});

test.each([
  "throws",
  "unsettled",
] as const)("C-ATTN-08 optional close classification (%s) cannot interrupt startup readiness", async (failure) => {
  const { cwd, session, render } = await setup();
  const observed = vi.fn();
  session.on("dialog", observed);
  try {
    await render(menu(cwd));
    await expect.poll(() => observed.mock.calls.length).toBe(1);
    await becomeReady(session.elwoodSessionId, cwd);
    const complete = vi.spyOn(CodexSessionImpl.prototype, "completeInitialReady");
    const { endStartup } = CodexWorkspaceTrustDiscovery.prototype;
    vi.spyOn(CodexWorkspaceTrustDiscovery.prototype, "endStartup").mockImplementationOnce(function (
      this: CodexWorkspaceTrustDiscovery,
    ) {
      vi.mocked(settledNativeSnapshot).mockImplementationOnce(() => {
        if (failure === "throws") throw new Error("optional observation unavailable");
        return undefined;
      });
      endStartup.call(this);
    });
    await render(codexTty(codexComposer));
    expect(session.status).toBe("ready");
    expect(complete).toHaveBeenCalledOnce();
    await expect
      .poll(() => observed.mock.lastCall?.[0])
      .toMatchObject({
        phase: "closed",
        reason: "unavailable",
      });
  } finally {
    await session.teardown();
  }
});
