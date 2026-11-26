/**
 * Claude offers auto-mode setup only when a turn ends in auto mode. A session launched in auto
 * mode holds queued input after its turns even when its footer does not show the mode, and a
 * session in another mode does not (C-ATTN-10, PRD §5.3).
 */
import { afterEach, expect, test } from "vitest";
import { turnEndSettleMs } from "../../src/claude/session/turn-end-hold.ts";
import { type ClaudePermissionMode, startClaude } from "../../src/index.ts";
import { claudeIdle, claudeWorking } from "../fixtures/owned-turn/composer.ts";
import { nativeHooks } from "../fixtures/owned-turn/session.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

const paste = "\u001b[200~queued\u001b[201~";
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test.each([
  { permissionMode: "auto", held: true },
  { permissionMode: "bypassPermissions", held: false },
] satisfies readonly {
  permissionMode: ClaudePermissionMode;
  held: boolean;
}[])("C-ATTN-10 a session launched with $permissionMode holds input after a turn: $held", async ({
  permissionMode,
  held,
}) => {
  const cwd = tempDir();
  installFakes();
  const live = await startClaude({ cwd, permissionMode });
  const pty = ptys[0]!;
  const hooks = nativeHooks("claude", live, cwd, pty);
  try {
    await hooks.ready();
    await expect.poll(() => live.status).toBe("ready");
    pty.emitData(claudeWorking);
    await hooks.submit("turn-1", "first");
    await expect.poll(() => live.status).toBe("running");
    const sending = live.sendMessage("queued");
    await hooks.stop("turn-1", "OK");
    // The footer shows another mode, so only the launch can tell this turn ended in auto mode.
    pty.emitData(claudeIdle);
    await wait(turnEndSettleMs / 2);
    expect(pty.writes.includes(paste)).toBe(!held);
    await expect.poll(() => pty.writes, { timeout: 3_000 }).toEqual([paste, "\r"]);
    await sending;
  } finally {
    await live.teardown();
  }
});
