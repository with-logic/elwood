/** Carry raw input from a settled native Codex workspace prelude into the trust menu (C-TRUST-01). */
import { afterEach, expect, test, vi } from "vitest";
import { tty } from "../fixtures/trust-composer.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";
import { rewordedGate } from "../helpers/unknown-gate.ts";
import { resetFakes } from "./helpers.ts";
import { menu, setup } from "./workspace-trust-discovery-fixture.ts";

afterEach(resetFakes);

function legacyWorkspaceMenu(cwd: string): string {
  return tty(
    capturedFrame("codex-0.154.0/directory").replace(
      "/private/tmp/elwood-native-codex-CAPTURE/project",
      cwd,
    ),
  );
}

test.each([
  ["folder access", menu, "  Trust this folder?"],
  ["legacy", legacyWorkspaceMenu, "  Do you trust"],
] as const)("C-TRUST-01 raw input on the settled %s prelude preempts automatic confirmation", async (_, nativeMenu, question) => {
  const { cwd, session, pty, render } = await setup({ autotrust: true });
  const events = vi.fn();
  session.on("dialog", events);
  try {
    const full = nativeMenu(cwd);
    const prelude = full.split(question)[0]!;
    await render(prelude);
    await session.sendKeys("x");
    await render(prelude);
    await render(full);
    expect(pty.writes).toEqual(["x"]);
    await expect
      .poll(() => events.mock.calls)
      .toMatchObject([[{ phase: "raised", request: { targetPath: cwd } }]]);
  } finally {
    await session.teardown();
  }
});

test("C-TRUST-01 a prelude claim is retired when a settled native frame replaces the prelude", async () => {
  const { cwd, session, pty, render } = await setup({ autotrust: true });
  try {
    const full = menu(cwd);
    await render(full.split("  Trust this folder?")[0]!);
    await session.sendKeys("x");
    await render("Preparing native startup configuration");
    await session.sendKeys("y");
    await render(full);
    expect(pty.writes).toEqual(["x", "y", "1\r"]);
  } finally {
    await session.teardown();
  }
});

test.each([
  ["quoted", (prelude: string) => `assistant: Earlier output\r\n${prelude}`],
  ["relative location", () => "> You are in project\r\n"],
] as const)("C-TRUST-01 unrelated %s output does not claim a native workspace question", async (_, fixture) => {
  const { cwd, session, pty, render } = await setup({ autotrust: true });
  try {
    const full = menu(cwd);
    await render(fixture(full.split("  Trust this folder?")[0]!));
    await session.sendKeys("x");
    await render(full);
    expect(pty.writes).toEqual(["x", "1\r"]);
  } finally {
    await session.teardown();
  }
});

test("C-TRUST-01 a host-written prelude does not claim a later native workspace question", async () => {
  const { cwd, session, pty, render } = await setup({ autotrust: true });
  try {
    const full = menu(cwd);
    await session.terminal.writeOutput(full.split("  Trust this folder?")[0]!);
    await session.sendKeys("x");
    await render(full);
    expect(pty.writes).toEqual(["x", "1\r"]);
  } finally {
    await session.teardown();
  }
});

test("C-TRUST-01 an unrelated settled hook question retires a pending workspace prelude claim", async () => {
  const { cwd, session, pty, render } = await setup({ autotrust: true });
  try {
    const full = menu(cwd);
    await render(full.split("  Trust this folder?")[0]!);
    await session.sendKeys("x");
    await render(tty(capturedFrame("codex-0.164.0/trust/hooks-no-hook-bypass")));
    await render(full);
    expect(pty.writes).toEqual(["x", "2\r", "1\r"]);
  } finally {
    await session.teardown();
  }
});

test("C-TRUST-01 an unsettled prelude alone cannot claim its workspace question", async () => {
  const { cwd, session, pty, render } = await setup({ autotrust: true });
  try {
    const full = menu(cwd);
    const prelude = full.split("  Trust this folder?")[0]!;
    await render(`\x1b[?2026h${prelude}`);
    await session.sendKeys("x");
    await render(`\x1b[?2026l${full}`);
    expect(pty.writes).toEqual(["x", "1\r"]);
  } finally {
    await session.teardown();
  }
});

test("C-TRUST-01 a settled prelude cannot claim a workspace question in another layout", async () => {
  const { cwd, session, pty, render } = await setup({ autotrust: true });
  try {
    await render(menu(cwd).split("  Trust this folder?")[0]!);
    await session.sendKeys("x");
    await render(legacyWorkspaceMenu(cwd));
    expect(pty.writes).toEqual(["x", "1\r"]);
  } finally {
    await session.teardown();
  }
});

test("C-TRUST-01 a complete off-allowlist gate retires the previously recorded prelude claim", async () => {
  const { cwd, session, pty, render } = await setup({ autotrust: true });
  try {
    const full = menu(cwd);
    const prelude = full.split("  Trust this folder?")[0]!;
    await render(prelude);
    await session.sendKeys("x");
    await render(prelude + tty(rewordedGate));
    await render(full);
    expect(pty.writes).toEqual(["x", "1\r"]);
  } finally {
    await session.teardown();
  }
});

test("C-TRUST-01 raw input on an off-allowlist gate cannot claim its successor from a retained prelude", async () => {
  const { cwd, session, pty, render } = await setup({ autotrust: true });
  try {
    const full = menu(cwd);
    await render(full.split("  Trust this folder?")[0]! + tty(rewordedGate));
    await session.sendKeys("x");
    await render(full);
    expect(pty.writes).toEqual(["x", "1\r"]);
  } finally {
    await session.teardown();
  }
});
