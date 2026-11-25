/** Exercise read-only Codex workspace trust discovery through the public session API (C-ATTN-07). */
import { mkdirSync, realpathSync, renameSync } from "node:fs";
import { join } from "node:path";
import { afterEach, assert, expect, test, vi } from "vitest";
import { CodexSession, startCodex } from "../../src/index.ts";
import { codexComposer, codexTty } from "../fixtures/trust-composer.ts";
import { createLinkedCheckout, registerWorktree } from "../helpers/codex-trust-worktree.ts";
import { becomeReady, installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";
import { clear, menu, setup } from "./workspace-trust-discovery-fixture.ts";

afterEach(resetFakes);

const expectedFolderQuestion =
  "Trust this folder? Codex can read, edit, and run files here, subject to your permission settings. Folder settings can run code automatically, even without a model request. Continue only if you trust these files. Your trust decision will be saved.";

test("C-ATTN-07 lists exact scope, text, choices and stable request identity", async () => {
  const { cwd, session, pty, render } = await setup();
  try {
    expect(await session.listDialogs()).toEqual([]);
    await render(menu(cwd));
    const [request] = await session.listDialogs();
    assert.isDefined(request);
    expect(request).toEqual({
      id: expect.any(String),
      elwoodSessionId: session.elwoodSessionId,
      agent: "codex",
      kind: "trust",
      label: "workspace_trust",
      targetPath: cwd,
      targetScope: "folder",
      text: expectedFolderQuestion,
      choices: [
        { id: expect.any(String), label: "Trust and continue" },
        { id: expect.any(String), label: "Quit" },
      ],
    });
    const ids = [request.id, ...request.choices.map(({ id }) => id)];
    expect(ids.every((id) => id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(3);
    await render(menu(cwd).replace("› 1.", "  1.").replace("  2.", "› 2."));
    expect((await session.listDialogs())[0]).toBe(request);

    await render(menu(cwd, "folder-access-no-hook-bypass"));
    const [replacement] = await session.listDialogs();
    assert.isDefined(replacement);
    expect(replacement.id).not.toBe(request.id);
    expect(replacement.choices[1]?.label).toBe("Back to Agent Command Center");
    expect(pty.writes).toEqual([]);

    await render("not a trust menu");
    expect(await session.listDialogs()).toEqual([]);
    await render(menu(cwd, "folder-access-no-hook-bypass"));
    const [restored] = await session.listDialogs();
    assert.isDefined(restored);
    expect(restored.id).not.toBe(replacement.id);
    await becomeReady(session.elwoodSessionId, cwd);
    await render(codexTty(codexComposer));
    expect(await session.listDialogs()).toEqual([]);
  } finally {
    await session.teardown();
  }
});

test("C-ATTN-07 lazy listing starts the session and uses the same target check", async () => {
  installFakes();
  const cwd = realpathSync.native(tempDir());
  const session = new CodexSession({ cwd });
  try {
    expect(session.session).toBeUndefined();
    expect(await session.listDialogs()).toEqual([]);
    const live = session.session;
    assert.isDefined(live);
    ptys[0]!.emitData(clear + menu(cwd));
    await live.terminal.settled();
    expect(await session.listDialogs()).toEqual([
      expect.objectContaining({ targetPath: cwd, targetScope: "folder" }),
    ]);
  } finally {
    await session.teardown();
  }
});

test("C-ATTN-07 input takeover exposes the native menu before automation would expire", async () => {
  installFakes({ supportsHookTrustBypass: false });
  const cwd = realpathSync.native(tempDir());
  const session = await startCodex({ cwd, autotrust: true });
  try {
    ptys[0]!.emitData(clear + menu(cwd));
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

test("C-ATTN-07 every read rechecks the launch folder identity", async () => {
  const { cwd, session, render } = await setup();
  try {
    await render(menu(cwd));
    expect(await session.listDialogs()).toHaveLength(1);
    renameSync(cwd, join(tempDir(), "old"));
    mkdirSync(cwd);
    expect(await session.listDialogs()).toEqual([]);
  } finally {
    await session.teardown();
  }
});

test("C-ATTN-07 revalidates the exact linked Git root even if the native row is unchanged", async () => {
  installFakes();
  const root = realpathSync.native(tempDir());
  const { checkout: cwd, repo } = createLinkedCheckout(root);
  const redirect = join(root, "project");
  mkdirSync(redirect);
  const session = await startCodex({ cwd, initialSize: { cols: 160, rows: 32 } });
  const note =
    "Note: You’re in a subdirectory of a Git project. Trusting will apply to the repository root:";
  const disclosure = (path: string) => `  ${note}\r\n  ${path.padEnd(repo.length + 4)}`;
  expect(disclosure(repo)).toBe(disclosure(redirect));
  try {
    const screen = menu(repo).replace(`  ${repo}`, disclosure(repo));
    ptys[0]!.emitData(clear + screen);
    await session.terminal.settled();
    expect(await session.listDialogs()).toEqual([
      expect.objectContaining({ targetPath: repo, targetScope: "repository" }),
    ]);
    registerWorktree(cwd, redirect);
    expect(await session.listDialogs()).toEqual([]);
    expect(ptys[0]!.writes).toEqual([]);
  } finally {
    await session.teardown();
  }
});

test("C-ATTN-07 rearmed automatic trust keeps ownership until the current attempt expires", async () => {
  installFakes({ supportsHookTrustBypass: false });
  const cwd = realpathSync.native(tempDir());
  const session = await startCodex({ cwd, autotrust: true });
  const pty = ptys[0]!;
  vi.useFakeTimers();
  try {
    const complete = menu(cwd);
    const incomplete = complete.split("› 1.")[0];
    assert.isDefined(incomplete);
    pty.emitData(clear + incomplete);
    await vi.advanceTimersByTimeAsync(5_020);
    expect(session.status).toBe("blocked");
    expect(await session.listDialogs()).toEqual([]);

    pty.emitData(clear + complete);
    await vi.advanceTimersByTimeAsync(20);
    expect(pty.writes).toEqual(["1\r"]);
    expect(session.status).toBe("blocked");
    expect(await session.listDialogs()).toEqual([]);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(await session.listDialogs()).toEqual([
      expect.objectContaining({ targetPath: cwd, targetScope: "folder" }),
    ]);
    const [, ...retries] = pty.writes;
    expect(retries.length).toBeGreaterThan(0);
    expect(retries).toEqual(retries.map(() => "\r"));

    pty.emitData(clear + codexTty(codexComposer));
    await vi.advanceTimersByTimeAsync(500);
    expect(pty.writes).toEqual(["1\r", ...retries]);
    expect(await session.listDialogs()).toEqual([]);
  } finally {
    vi.useRealTimers();
    await session.teardown();
  }
});
