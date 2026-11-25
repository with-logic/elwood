/** Verify native Codex workspace trust replay and cancellation on the lazy facade (C-ATTN-08). */
import { realpathSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { afterEach, assert, expect, expectTypeOf, test, vi } from "vitest";
import { CodexWorkspaceTrustDiscovery } from "../../src/codex/workspace-trust/discovery.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";
import { CodexSession, type ElwoodDialogEvent } from "../../src/index.ts";
import { assertStartupUsable, setStartupWaitMsForTests } from "../../src/runtime/startup/index.ts";
import { codexComposer, codexTty } from "../fixtures/trust-composer.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";
import { clear, menu, menuWithQuitSelected } from "./workspace-trust-discovery-fixture.ts";

vi.mock("../../src/runtime/startup/index.ts", { spy: true });
afterEach(() => {
  vi.restoreAllMocks();
  resetFakes();
});

test.each([
  ["visible", [], 1],
  ["cleared", [codexTty(codexComposer)], 0],
] as const)("C-ATTN-08 lazy startup replays only active verified state (%s)", async (_, frames, count) => {
  installFakes();
  const cwd = realpathSync.native(tempDir());
  const session = new CodexSession({ cwd });
  const observed = vi.fn<(event: ElwoodDialogEvent) => void>();
  session.on("dialog", (event) => {
    expectTypeOf(event).toEqualTypeOf<ElwoodDialogEvent>();
    observed(event);
  });
  const removedBeforeReplay = vi.fn();
  session.on("dialog", () => session.off("dialog", removedBeforeReplay));
  session.on("dialog", removedBeforeReplay);
  const startupEntered = Promise.withResolvers<void>();
  const finishStartup = Promise.withResolvers<void>();
  const { assertStartupUsable: checkStartup } = await vi.importActual<
    typeof import("../../src/runtime/startup/index.ts")
  >("../../src/runtime/startup/index.ts");
  vi.mocked(assertStartupUsable).mockImplementation(async (options) => {
    startupEntered.resolve();
    await finishStartup.promise;
    await checkStartup(options);
  });
  setStartupWaitMsForTests(0);
  const emitted = vi.spyOn(TypedEmitter.prototype, "emit");
  const renders = () => emitted.mock.calls.filter(([name]) => name === "terminal:data").length;
  const starting = session.start();
  try {
    await startupEntered.promise;
    const pty = ptys[0];
    assert.isDefined(pty);
    pty.emitData(clear + menu(cwd));
    await expect.poll(renders).toBe(1);
    for (const frame of frames) pty.emitData(clear + frame);
    await expect.poll(renders).toBe(1 + frames.length);
    expect(session.session).toBeUndefined();
    finishStartup.resolve();
    await starting;
    await expect.poll(() => observed.mock.calls.length).toBe(count);
    const requests = await session.listDialogs();
    expect(observed.mock.calls).toEqual(
      requests.map((request) => [{ phase: "raised", request } satisfies ElwoodDialogEvent]),
    );
    expect(requests).toHaveLength(count);
    expect(removedBeforeReplay).not.toHaveBeenCalled();
  } finally {
    finishStartup.resolve();
    await session.teardown();
  }
});

test("C-ATTN-08 a late lazy listener waits through an unsettled same-menu repaint", async () => {
  installFakes();
  const cwd = realpathSync.native(tempDir());
  const session = new CodexSession({ cwd });
  const live = vi.fn();
  session.on("dialog", live);
  try {
    const active = await session.start();
    const pty = ptys[0];
    assert.isDefined(pty);
    pty.emitData(clear + menu(cwd));
    await expect.poll(() => live.mock.calls.length).toBe(1);
    const checks = vi.spyOn(CodexWorkspaceTrustDiscovery.prototype, "readForPublication");
    pty.emitData(`\x1b[?2026h${clear}${menuWithQuitSelected(cwd)}`);
    await active.terminal.settled();
    const late = vi.fn();
    session.on("dialog", late);
    await setImmediate();
    expect(checks).not.toHaveBeenCalled();
    expect(late).not.toHaveBeenCalled();
    pty.emitData("\x1b[?2026l");
    await expect.poll(() => late.mock.calls).toEqual(live.mock.calls);
  } finally {
    await session.teardown();
  }
});
