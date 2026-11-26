/**
 * Claude offers auto-mode setup only when a turn ends in auto mode. A session launched in auto
 * mode, or resumed from one, holds queued input after its turns even when its footer does not
 * show the mode; another session holds it only when the footer row under its composer shows
 * auto mode, never for transcript text that quotes it (C-ATTN-10, PRD §5.3).
 */
import { afterEach, expect, test, vi } from "vitest";
import { turnEndSettleMs } from "../../src/claude/session/turn-end-hold.ts";
import {
  type ClaudePermissionMode,
  type ClaudeSessionApi,
  resumeClaude,
  startClaude,
} from "../../src/index.ts";
import { claudeIdle, claudeWorking } from "../fixtures/owned-turn/composer.ts";
import { nativeHooks } from "../fixtures/owned-turn/session.ts";
import type { FakePty } from "../helpers/fake-pty.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

const paste = "\u001b[200~queued\u001b[201~";
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Waits for `ready()` without asserting, so that helpers can share it. */
const until = (ready: () => boolean, timeoutMs = 1_000) =>
  vi.waitFor(
    () => {
      if (!ready()) throw new Error("Not yet");
    },
    { timeout: timeoutMs },
  );
const rule = "─".repeat(60);
/** A working screen whose footer, under the composer's bottom rule, shows `mode`. */
const footed = (mode: string, above = "") =>
  `\x1b[2J\x1b[H${above}\r\n${rule}\r\n❯ \r\n${rule}\r\n  ${mode} (shift+tab to cycle) · esc to interrupt`;
const quoted = footed("⏵⏵ bypass permissions on", "The footer then reads ⏵⏵ auto mode on.");

/** Ends a turn of `live` on `working` with input queued: was it held, and what went out. */
async function heldAfterTurn(
  live: ClaudeSessionApi,
  pty: FakePty,
  cwd: string,
  working: string,
  quietFrames = 0,
) {
  const hooks = nativeHooks("claude", live, cwd, pty);
  await hooks.ready();
  await until(() => live.status === "ready");
  for (let frame = 0; frame < quietFrames; frame += 1) {
    pty.emitData(claudeIdle);
    await live.terminal.settled();
  }
  pty.emitData(working);
  await hooks.submit("turn-1", "first");
  await until(() => live.status === "running");
  const sending = live.sendMessage("queued");
  await hooks.stop("turn-1", "OK");
  pty.emitData(claudeIdle);
  await wait(turnEndSettleMs / 2);
  const held = !pty.writes.includes(paste);
  await until(() => pty.writes.length >= 2, 3_000);
  await sending;
  return { held, writes: [...pty.writes] };
}

test.each([
  { permissionMode: "auto", footer: "another mode", working: claudeWorking, held: true },
  {
    permissionMode: "bypassPermissions",
    footer: "another mode",
    working: claudeWorking,
    held: false,
  },
  {
    permissionMode: "bypassPermissions",
    footer: "auto mode",
    working: footed("⏵⏵ auto mode on"),
    held: true,
  },
  {
    permissionMode: "bypassPermissions",
    footer: "another mode, with auto mode quoted above",
    working: quoted,
    held: false,
  },
] satisfies readonly {
  permissionMode: ClaudePermissionMode;
  footer: string;
  working: string;
  held: boolean;
}[])("C-ATTN-10 a session launched with $permissionMode, its footer showing $footer, holds input after a turn: $held", async ({
  permissionMode,
  working,
  held,
}) => {
  const cwd = tempDir();
  installFakes();
  const live = await startClaude({ cwd, permissionMode });
  try {
    expect(await heldAfterTurn(live, ptys[0]!, cwd, working)).toEqual({
      held,
      writes: [paste, "\r"],
    });
  } finally {
    await live.teardown();
  }
});

test("C-ATTN-10 a session resumed from an auto-mode launch holds input after a turn", async () => {
  const cwd = tempDir();
  installFakes();
  const original = await startClaude({ cwd, permissionMode: "auto" });
  await ptys[0]!.dispatchHook(original.elwoodSessionId, {
    hook_event_name: "UserPromptSubmit",
    // The native session the resumed hooks report (`nativeHooks`).
    session_id: "claude-1",
    cwd,
    prompt: "existing conversation",
    model: "fixture",
  });
  await original.stop();
  // The resume names no mode, so only the persisted launch says this session is in auto mode.
  const live = await resumeClaude({ cwd, elwoodSessionId: original.elwoodSessionId });
  try {
    // A resumed session reads turns on screen once its composer has stayed quiet (C-TURN-03).
    expect(await heldAfterTurn(live, ptys[1]!, cwd, claudeWorking, 6)).toEqual({
      held: true,
      writes: [paste, "\r"],
    });
  } finally {
    await live.teardown();
  }
});
