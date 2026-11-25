/** Verify Codex native workspace trust discovery and lifecycle (C-ATTN-08). */
import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { afterEach, assert, expect, test, vi } from "vitest";
import type { ElwoodDialogEvent } from "../../src/index.ts";
import { codexComposer, codexTty } from "../fixtures/trust-composer.ts";
import { resetFakes, tempDir } from "./helpers.ts";
import { clear, menu, menuWithQuitSelected, setup } from "./workspace-trust-discovery-fixture.ts";

afterEach(resetFakes);

test("C-ATTN-08 retires the request on composer clearance and skips replaced listeners", async () => {
  const { cwd, session, render } = await setup();
  const transitions: ElwoodDialogEvent[] = [];
  const closedAtReady = vi.fn();
  const reattached = vi.fn();
  session.on("dialog", (event) => {
    transitions.push(event);
    if (event.phase === "raised") {
      session.off("dialog", reattached);
      session.on("dialog", reattached);
    }
  });
  session.on("dialog", reattached);
  session.on("status", ({ status }) => {
    if (status === "ready") void session.listDialogs().then(closedAtReady);
  });
  try {
    await render("Waiting for Codex");
    expect(transitions).toEqual([]);
    await render(menu(cwd));
    await expect.poll(() => reattached.mock.calls.length).toBe(1);
    expect(transitions.map(({ phase }) => phase)).toEqual(["raised"]);
    const [request] = await session.listDialogs();
    assert.isDefined(request);
    expect(transitions).toEqual([{ phase: "raised", request }]);
    await render(menuWithQuitSelected(cwd));
    expect(await session.listDialogs()).toEqual([request]);
    await render(codexTty(codexComposer));
    await expect.poll(() => closedAtReady.mock.calls).toEqual([[[]]]);
    await expect
      .poll(() => transitions)
      .toEqual([
        { phase: "raised", request },
        { phase: "closed", reason: "cleared", request },
      ]);
    await render(menu(cwd));
    expect(await session.listDialogs()).toEqual([]);
  } finally {
    await session.teardown();
  }
});

test("C-ATTN-08 replaces changed native choices while listener failures stay contained", async () => {
  const { cwd, session, render } = await setup();
  const events = vi.fn<(event: ElwoodDialogEvent) => void>();
  session.on("dialog", () => {
    throw new Error("host listener");
  });
  session.on("dialog", vi.fn().mockRejectedValue(new Error("host rejection")));
  session.on("dialog", events);
  try {
    await render(menu(cwd));
    await expect.poll(() => events.mock.calls.length).toBe(1);
    const [initial] = await session.listDialogs();
    assert.isDefined(initial);
    const replacedBeforeReplay = vi.fn();
    session.on("dialog", replacedBeforeReplay)();
    session.on("dialog", replacedBeforeReplay);
    const rejected = Promise.withResolvers<void>();
    const ownThen = vi.fn(() => {
      throw new Error("replay listener own then");
    });
    // biome-ignore lint/suspicious/noThenProperty: a genuine Promise can override its then property.
    Object.defineProperty(rejected.promise, "then", { get: ownThen });
    const replayed: ElwoodDialogEvent[] = [];
    const replay = (event: ElwoodDialogEvent) => {
      replayed.push(event);
      return rejected.promise;
    };
    session.on("dialog", replay);
    session.on("dialog", replay);
    await expect.poll(() => replayed).toEqual([{ phase: "raised", request: initial }]);
    rejected.reject(new Error("replay rejection"));
    expect(ownThen).not.toHaveBeenCalled();
    expect(replacedBeforeReplay).toHaveBeenCalledExactlyOnceWith({
      phase: "raised",
      request: initial,
    });
    await render(menu(cwd, "folder-access-no-hook-bypass"));
    await expect
      .poll(() => events.mock.calls.map(([event]) => event.phase))
      .toEqual(["raised", "closed", "raised"]);
    const [replacement] = await session.listDialogs();
    assert.isDefined(replacement);
    expect(replacement.id).not.toBe(initial.id);
    expect(events.mock.calls).toEqual([
      [{ phase: "raised", request: initial }],
      [{ phase: "closed", reason: "replaced", request: initial }],
      [{ phase: "raised", request: replacement }],
    ]);
    await render("an unsupported native screen");
    await expect
      .poll(() => events.mock.lastCall?.[0])
      .toEqual({
        phase: "closed",
        reason: "unavailable",
        request: replacement,
      });
    expect(await session.listDialogs()).toEqual([]);
  } finally {
    await session.teardown();
  }
});

test("C-ATTN-08 host output retires discovery and reentrant listeners preserve write order", async () => {
  const { cwd, session, render } = await setup();
  const changed = vi.fn();
  session.on("dialog", (event) => {
    changed(event);
    if (event.phase === "closed") void session.terminal.writeOutput(" SECOND");
  });
  try {
    await render(menu(cwd));
    await expect.poll(() => changed.mock.calls.length).toBe(1);
    const write = session.terminal.writeOutput(`${clear}FIRST`);
    const late = vi.fn();
    session.on("dialog", late);
    await write;
    await expect.poll(() => changed.mock.calls.length).toBe(2);
    await session.terminal.settled();
    expect(late).not.toHaveBeenCalledWith(expect.objectContaining({ phase: "raised" }));
    expect(session.terminal.snapshot().text).toContain("FIRST SECOND");
    expect(await session.listDialogs()).toEqual([]);
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "closed" }));
  } finally {
    await session.teardown();
  }
});

test("C-ATTN-08 does not announce native evidence revoked before delivery", async () => {
  const { cwd, session, render } = await setup();
  const observed = vi.fn();
  session.on("dialog", observed);
  session.on("terminal:data", () => {
    void session.terminal.writeOutput(clear + menu(cwd));
  });
  try {
    await render(menu(cwd));
    expect(await session.listDialogs()).toEqual([]);
    expect(observed).not.toHaveBeenCalled();
  } finally {
    await session.teardown();
  }
});

test("C-ATTN-08 workspace mutation by the close listener suppresses a replacement raise", async () => {
  const { cwd, session, render } = await setup();
  const original = join(tempDir(), "original");
  const phases: string[] = [];
  session.on("dialog", (event) => {
    phases.push(event.phase);
    if (event.phase === "closed" && event.reason === "replaced") {
      renameSync(cwd, original);
      mkdirSync(cwd);
    }
  });
  try {
    await render(menu(cwd));
    await expect.poll(() => phases).toEqual(["raised"]);
    await render(menu(cwd, "folder-access-no-hook-bypass"));
    await expect.poll(() => phases).toEqual(["raised", "closed"]);
    expect(await session.listDialogs()).toEqual([]);
    expect(phases).toEqual(["raised", "closed"]);
  } finally {
    await session.teardown();
  }
});
