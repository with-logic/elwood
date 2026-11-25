/** Verify workspace prelude ownership across native PTY repaint boundaries (C-TRUST-01). */
import { afterEach, expect, test, vi } from "vitest";
import { codexComposer, codexTty } from "../fixtures/trust-composer.ts";
import { becomeReady, resetFakes } from "./helpers.ts";
import { clear, menu, setup } from "./workspace-trust-discovery-fixture.ts";

afterEach(resetFakes);

test("C-TRUST-01 raw input while the compatible native question is staged owns the visible prelude", async () => {
  const { cwd, session, pty, render } = await setup({ autotrust: true });
  const events = vi.fn();
  session.on("dialog", events);
  try {
    const full = menu(cwd);
    await render(full.split("  Trust this folder?")[0]!);

    pty.emitData(clear + full);
    await session.sendKeys(new Uint8Array([120]));
    await session.terminal.settled();

    await expect
      .poll(() => events.mock.calls)
      .toMatchObject([[{ phase: "raised", request: { targetPath: cwd } }]]);
    expect(pty.writes).toEqual(["x"]);
  } finally {
    await session.teardown();
  }
});

test("C-TRUST-01 raw input on the last settled prelude is retained during synchronized repaint", async () => {
  const { cwd, session, pty, render } = await setup({ autotrust: true });
  const events = vi.fn();
  session.on("dialog", events);
  try {
    const full = menu(cwd);
    await render(full.split("  Trust this folder?")[0]!);
    await render("\x1b[?2026h");
    await session.sendKeys("x");
    await render(`\x1b[?2026l${full}`);

    await expect
      .poll(() => events.mock.calls)
      .toMatchObject([[{ phase: "raised", request: { targetPath: cwd } }]]);
    expect(pty.writes).toEqual(["x"]);
  } finally {
    await session.teardown();
  }
});

test("C-TRUST-01 host output revokes a previously recorded native prelude claim", async () => {
  const { cwd, session, pty, render } = await setup({ autotrust: true });
  const events = vi.fn();
  session.on("dialog", events);
  try {
    const full = menu(cwd);
    await render(full.split("  Trust this folder?")[0]!);
    await session.sendKeys("x");
    await session.terminal.writeOutput("\x1b[0m");
    await render(full);

    expect(pty.writes).toEqual(["x", "1\r"]);
    expect(await session.listDialogs()).toEqual([]);
    expect(events).not.toHaveBeenCalled();
  } finally {
    await session.teardown();
  }
});

test("C-TRUST-01 verified readiness ends the observer even with a pending raw prelude claim", async () => {
  const { cwd, session, pty, render } = await setup({ autotrust: true });
  try {
    const full = menu(cwd);
    const prelude = full.split("  Trust this folder?")[0]!;
    await render(prelude);
    await session.sendKeys("x");
    await becomeReady(session.elwoodSessionId, cwd);
    await render(codexTty(codexComposer));
    expect(session.status).toBe("ready");

    await render(prelude);
    await session.sendKeys("y");
    await render(full);
    expect(pty.writes).toEqual(["x", "y", "1\r"]);
  } finally {
    await session.teardown();
  }
});
