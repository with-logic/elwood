/** Settled live trust and foreign picker holds keep working during scrollback (PRD §5.3). */
import { afterEach, expect, test, vi } from "vitest";
import { type ElwoodActivityEvent, startClaude, startCodex } from "../../src/index.ts";
import * as claude from "../claude/helpers.ts";
import { instructionsLoaded } from "../claude/login-helpers.ts";
import * as codex from "../codex/helpers.ts";
import {
  claudeComposer,
  claudeTrust,
  claudeTty,
  codexComposer,
  codexTrust,
  codexTty,
  tty,
} from "../fixtures/trust-composer.ts";
import { viewTerminalHistory } from "../helpers/live-buffer-fixture.ts";
import { claudePickerViewport, codexPickerViewport } from "../helpers/model-dialog-viewports.ts";

afterEach(() => {
  vi.useRealTimers();
  claude.resetFakes();
  codex.resetFakes();
});

test.each([
  "claude",
  "codex",
] as const)("C-TRUST-01 %s confirms the startup trust screen while the host shows history", async (agent) => {
  const helper = agent === "claude" ? claude : codex;
  helper.installFakes();
  const cwd = helper.tempDir();
  const session = await (agent === "claude" ? startClaude : startCodex)({ cwd, autotrust: true });
  const pty = helper.ptys[0]!;
  const events: string[] = [];
  const activity: {
    on(event: "activity", listener: (event: ElwoodActivityEvent) => void): void;
  } = session;
  activity.on("activity", ({ kind, label }) => events.push(`${kind}:${label}`));
  try {
    const terminal = session.terminal;
    const { isScrolled, paint } = await viewTerminalHistory(terminal, pty);
    terminal.xterm.onData(() => terminal.xterm.scrollToTop());
    await paint(
      tty(
        agent === "claude"
          ? `${claudeTrust}\n1. Yes, I trust this folder`
          : `${codexTrust}\n› 1. Yes, continue`,
      ),
    );
    await expect.poll(() => pty.writes).toEqual(["1\r"]);
    expect(isScrolled()).toBe(true);
    expect(events).not.toContain("startup_prompt:workspace_trust");
    await paint(agent === "claude" ? claudeTty(claudeComposer) : codexTty(codexComposer));
    await expect.poll(() => events).toContain("startup_prompt:workspace_trust");
    expect(isScrolled()).toBe(true);
    expect(pty.writes).toEqual(["1\r"]);
  } finally {
    await session.stop();
  }
});

test.each([
  "claude",
  "codex",
] as const)("C-API-55 %s holds input for a hidden foreign model picker and releases only at its composer", async (agent) => {
  const helper = agent === "claude" ? claude : codex;
  helper.installFakes();
  const cwd = helper.tempDir();
  const session = await (agent === "claude" ? startClaude : startCodex)({ cwd });
  const pty = helper.ptys[0]!;
  try {
    if (agent === "claude")
      await pty.dispatchHook(session.elwoodSessionId, instructionsLoaded(cwd));
    else await codex.becomeReady(session.elwoodSessionId, cwd);
    const { isScrolled, paint } = await viewTerminalHistory(session.terminal, pty);
    await paint(tty(agent === "claude" ? claudePickerViewport : codexPickerViewport));
    expect(isScrolled()).toBe(true);
    vi.useFakeTimers();
    const sent = session.sendMessage("after the chooser");
    void sent.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(350);
    expect(pty.writes).toEqual([]);
    const cleared = paint(agent === "claude" ? claudeTty(claudeComposer) : codexTty(codexComposer));
    await vi.advanceTimersByTimeAsync(500);
    await cleared;
    await sent;
    expect(pty.writes).toEqual(["\u001b[200~after the chooser\u001b[201~", "\r"]);
  } finally {
    vi.useRealTimers();
    await session.stop();
  }
});
