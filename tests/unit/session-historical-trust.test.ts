/** Workspace trust authorization comes from the live buffer only (C-TRUST-01). */
import { afterEach, expect, test } from "vitest";
import { trustPromptVisible } from "../../src/core/trust/view.ts";
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

afterEach(() => {
  claude.resetFakes();
  codex.resetFakes();
});

test.each([
  {
    agent: "claude",
    trust: `${claudeTrust}\n❯ 1. Yes, I trust this folder\n  2. No, exit`,
    composer: claudeTty(claudeComposer),
  },
  {
    agent: "codex",
    trust: `${codexTrust}\n› 1. Yes, continue\n  2. No, quit`,
    composer: codexTty(codexComposer),
  },
] as const)("C-TRUST-01 $agent ignores workspace trust in scrollback", async ({
  agent,
  trust,
  composer,
}) => {
  const helper = agent === "claude" ? claude : codex;
  helper.installFakes();
  const cwd = helper.tempDir();
  const session = await (agent === "claude" ? startClaude : startCodex)({ cwd, autotrust: true });
  const pty = helper.ptys[0]!;
  const events: ElwoodActivityEvent[] = [];
  const activity: {
    on(event: "activity", listener: (event: ElwoodActivityEvent) => void): void;
  } = session;
  activity.on("activity", (event) => events.push(event));
  try {
    const terminal = session.terminal;
    const { isScrolled, paint } = await viewTerminalHistory(
      terminal,
      pty,
      tty(trust) + "\r\n".repeat(terminal.size.rows),
    );
    await paint(composer);
    expect(isScrolled()).toBe(true);
    expect(trustPromptVisible(terminal.snapshot().text, agent)).toBe(true);
    if (agent === "claude")
      await pty.dispatchHook(session.elwoodSessionId, instructionsLoaded(cwd));
    else await codex.becomeReady(session.elwoodSessionId, cwd);
    expect(pty.writes).toEqual([]);
    expect(events.some((event) => event.kind === "startup_prompt")).toBe(false);
    await session.sendMessage("outside the historical gate");
    expect(pty.writes).toEqual(["\u001b[200~outside the historical gate\u001b[201~", "\r"]);
  } finally {
    await session.teardown();
  }
});
