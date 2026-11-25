/** Verify the ownership and subscription gates for Codex workspace trust events (C-ATTN-08). */
import { realpathSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { afterEach, assert, expect, test, vi } from "vitest";
import { CodexSessionImpl } from "../../src/codex/session/instance.ts";
import { CodexWorkspaceTrustDiscovery } from "../../src/codex/workspace-trust/discovery.ts";
import { type CodexSessionApi, startCodex } from "../../src/index.ts";
import { settledNativeSnapshot } from "../../src/terminal/cursor.ts";
import { codexComposer, codexTty } from "../fixtures/trust-composer.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";
import {
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
  ["never attached", () => {}],
  ["detached before proof", (session: CodexSessionApi) => session.on("dialog", vi.fn())()],
] as const)("C-ATTN-08 a session without listeners retains read authority (%s)", async (_, subscribe) => {
  const { cwd, session, render } = await setup();
  const checks = vi.spyOn(CodexWorkspaceTrustDiscovery.prototype, "readForPublication");
  try {
    subscribe(session);
    await render(menu(cwd));
    await setImmediate();
    expect(checks).not.toHaveBeenCalled();
    expect(await session.listDialogs()).toHaveLength(1);
  } finally {
    await session.teardown();
  }
});

test("C-ATTN-08 detaching the last listener abandons the pending initial proof", async () => {
  const { cwd, session, render } = await setup();
  const held = proofPause();
  try {
    await render(menu(cwd));
    await interceptWorkspaceLookup(cwd, (index) => (index === 0 ? held.wait() : undefined));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const off = session.on("dialog", vi.fn());
    await held.began;
    off();
    await vi.advanceTimersByTimeAsync(500);
    vi.useRealTimers();
    expect(await session.listDialogs()).toHaveLength(1);
  } finally {
    vi.useRealTimers();
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
    const warnings = vi.fn();
    session.on("warning", warnings);
    session.terminal.xterm.options.allowProposedApi = false;
    session.on("dialog", observed);
    await expect
      .poll(() => observed.mock.calls)
      .toEqual([[{ phase: "closed", reason: "unavailable", request: expect.any(Object) }]]);
    session.terminal.xterm.options.allowProposedApi = true;
    expect(await session.listDialogs()).toHaveLength(1);
    expect(warnings).not.toHaveBeenCalled();
  } finally {
    session.terminal.xterm.options.allowProposedApi = true;
    await session.teardown();
  }
});

test("C-ATTN-08 a same-menu repaint keeps the announcement and verifies only on demand", async () => {
  const { cwd, session, render } = await setup();
  const announced = vi.fn();
  session.on("dialog", announced);
  try {
    await render(menu(cwd));
    await expect.poll(() => announced.mock.calls.length).toBe(1);
    const checks = vi.spyOn(CodexWorkspaceTrustDiscovery.prototype, "readForPublication");
    await render(menuWithQuitSelected(cwd));
    await setImmediate();
    expect(checks).not.toHaveBeenCalled();
    expect(announced).toHaveBeenCalledTimes(1);
    const late = vi.fn();
    session.on("dialog", late)();
    await setImmediate();
    expect(checks).not.toHaveBeenCalled();
    session.on("dialog", late);
    await expect.poll(() => late.mock.calls).toEqual(announced.mock.calls);
    expect(checks).toHaveBeenCalledOnce();
  } finally {
    await session.teardown();
  }
});

test.each([
  [
    "throws",
    (): never => {
      throw new Error("optional observation unavailable");
    },
  ],
  ["unsettled", (): undefined => undefined],
] as const)("C-ATTN-08 optional close classification (%s) cannot interrupt startup readiness", async (_, snapshot) => {
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
      vi.mocked(settledNativeSnapshot).mockImplementationOnce(snapshot);
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
