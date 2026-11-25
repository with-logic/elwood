/** Exercise Claude's read-only workspace trust discovery through both session APIs (C-ATTN-07). */
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, renameSync } from "node:fs";
import { join } from "node:path";
import { afterEach, assert, expect, test, vi } from "vitest";
import { ClaudeSession, startClaude } from "../../src/index.ts";
import { claudeComposer, claudeTty } from "../fixtures/trust-composer.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";
import { trustFrame } from "./workspace-trust-discovery-fixture.ts";

afterEach(resetFakes);
const expectedText =
  "Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first. Claude Code'll be able to read, edit, and execute files here. Security guide";

test("C-ATTN-07 Claude lists exact text and ordered choices across a cursor redraw", async () => {
  installFakes();
  const cwd = realpathSync(tempDir());
  const lazy = new ClaudeSession({ cwd });
  try {
    expect(lazy.session).toBeUndefined();
    expect(await lazy.listDialogs()).toEqual([]);
    const session = lazy.session;
    assert.isDefined(session);
    const pty = ptys[0]!;
    const render = async (frame: string) => {
      pty.emitData(frame);
      await session.terminal.settled();
    };
    const menu = trustFrame(cwd);
    await render(menu);
    const [request] = await lazy.listDialogs();
    assert.isDefined(request);
    expect(request).toEqual({
      id: expect.any(String),
      elwoodSessionId: session.elwoodSessionId,
      agent: "claude",
      kind: "trust",
      label: "workspace_trust",
      targetPath: cwd,
      targetScope: "folder",
      text: expectedText,
      choices: [
        { id: expect.any(String), label: "No, exit" },
        { id: expect.any(String), label: "Yes, I trust this folder" },
      ],
    });
    expect(new Set([request.id, ...request.choices.map(({ id }) => id)]).size).toBe(3);
    const sameIds = expect.objectContaining({
      id: request.id,
      choices: request.choices.map(({ id }) => expect.objectContaining({ id })),
    });
    await render(menu.replace("❯ No", "  No").replace("   Yes", " ❯ Yes"));
    expect(await session.listDialogs()).toEqual([sameIds]);

    pty.emitData("\x1b[?2026h");
    const settled = vi.spyOn(session.terminal, "settled");
    expect(await session.listDialogs()).toEqual([]);
    expect(settled).not.toHaveBeenCalled();
    await session.terminal.settled();
    await render("\x1b[?2026l");
    expect(await session.listDialogs()).toEqual([sameIds]);

    const reorderedMenu = menu.replace(
      "No, exit\r\n   Yes, I trust this folder",
      "Yes, I trust this folder\r\n   No, exit",
    );
    await render(reorderedMenu);
    const [replacement] = await session.listDialogs();
    assert.isDefined(replacement);
    expect(replacement.id).not.toBe(request.id);
    expect(replacement.choices[0]?.label).toBe("Yes, I trust this folder");

    await render(reorderedMenu.replace("Accessing workspace:", "Verifying workspace:"));
    await render(reorderedMenu);
    const [restored] = await session.listDialogs();
    assert.isDefined(restored);
    expect(restored.id).not.toBe(replacement.id);
    expect(restored.choices.map(({ id }) => id)).not.toEqual(
      replacement.choices.map(({ id }) => id),
    );
    expect(pty.writes).toEqual([]);

    await render(`\x1b[2J\x1b[H${claudeTty(claudeComposer)}`);
    await render(menu);
    expect(await session.listDialogs()).toEqual([]);
  } finally {
    await lazy.teardown();
  }
});

test("C-ATTN-07 Claude rechecks repository scope and retires a lost target", async () => {
  installFakes();
  const repo = realpathSync(tempDir());
  execFileSync("git", ["-C", repo, "init", "-q"]);
  const cwd = join(repo, "nested");
  mkdirSync(cwd);
  const session = await startClaude({ cwd });
  const pty = ptys[0]!;
  const marker = join(repo, ".git");
  const backup = join(repo, "former-git");
  try {
    pty.emitData(trustFrame(cwd));
    await session.terminal.settled();
    expect(await session.listDialogs()).toEqual([
      expect.objectContaining({ targetPath: repo, targetScope: "repository" }),
    ]);
    renameSync(marker, backup);
    expect(await session.listDialogs()).toEqual([]);
    renameSync(backup, marker);
    pty.emitData(trustFrame(cwd));
    await session.terminal.settled();
    expect(await session.listDialogs()).toEqual([]);
    expect(session.status).toBe("blocked");
    expect(pty.writes).toEqual([]);
  } finally {
    await session.teardown();
  }
});

test("C-ATTN-07 raw caller input takes Claude workspace trust ownership", async () => {
  installFakes();
  const cwd = realpathSync(tempDir());
  const session = await startClaude({ cwd, autotrust: true });
  try {
    ptys[0]!.emitData(trustFrame(cwd));
    await session.terminal.settled();
    expect(await session.listDialogs()).toEqual([]);
    await session.sendKeys("x");
    expect(await session.listDialogs()).toEqual([
      expect.objectContaining({ targetPath: cwd, targetScope: "folder" }),
    ]);
  } finally {
    await session.teardown();
  }
});

test("C-ATTN-07 a rearmed Claude trust attempt owns its menu until expiry", async () => {
  installFakes();
  const cwd = realpathSync(tempDir());
  const session = await startClaude({ cwd, autotrust: true });
  const pty = ptys[0]!;
  vi.useFakeTimers();
  try {
    const complete = trustFrame(cwd);
    const unselected = complete.replace("❯ No", "  No");
    pty.emitData(unselected);
    await vi.advanceTimersByTimeAsync(5_020);
    expect(session.status).toBe("blocked");
    expect(await session.listDialogs()).toEqual([]);

    pty.emitData(complete);
    await vi.advanceTimersByTimeAsync(20);
    expect(session.status).toBe("blocked");
    expect(await session.listDialogs()).toEqual([]);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(await session.listDialogs()).toEqual([
      expect.objectContaining({ targetPath: cwd, targetScope: "folder" }),
    ]);
  } finally {
    vi.useRealTimers();
    await session.teardown();
  }
});
