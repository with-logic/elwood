/** Bound Codex trust scope proof and remove it as soon as native authority ends (C-ATTN-07). */
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { codexComposer, codexTty } from "../fixtures/trust-composer.ts";
import { holdFirstGitLookup } from "../helpers/hold-git-lookup.ts";
import { resetFakes } from "./helpers.ts";
import { menu, setup } from "./workspace-trust-discovery-fixture.ts";

vi.mock("node:fs/promises", { spy: true });
afterEach(() => {
  vi.restoreAllMocks();
  resetFakes();
});

test("C-ATTN-07 a superseded stalled proof does not cancel a newer frame", async () => {
  const { cwd, session, render } = await setup();
  const held = await holdFirstGitLookup(fsp.lstat, cwd);
  try {
    await render(menu(cwd));
    const old = session.listDialogs();
    await held.began;
    await render(menu(cwd, "folder-access-no-hook-bypass"));
    await expect(
      Promise.race([
        session.listDialogs(),
        new Promise((resolve) => setImmediate(() => resolve("waiting"))),
      ]),
    ).resolves.toEqual([]);
    expect(await old).toEqual([]);
    expect(await session.listDialogs()).toEqual([
      expect.objectContaining({
        choices: [
          expect.objectContaining({ label: "Trust and continue" }),
          expect.objectContaining({ label: "Back to Agent Command Center" }),
        ],
      }),
    ]);
  } finally {
    held.release();
    await session.teardown();
  }
});

test("C-ATTN-07 overlapping reads share pending proof for one settled frame", async () => {
  const { cwd, session, render } = await setup();
  const held = await holdFirstGitLookup(fsp.lstat, cwd);
  try {
    await render(menu(cwd));
    const first = session.listDialogs();
    await held.began;
    const second = session.listDialogs();
    held.release();
    const [[a], [b]] = await Promise.all([first, second]);
    expect(a).toBeDefined();
    expect(b).toBe(a);
    expect(
      vi.mocked(fsp.lstat).mock.calls.filter(([path]) => path === join(cwd, ".git")),
    ).toHaveLength(1);
  } finally {
    held.release();
    await session.teardown();
  }
});

test("C-ATTN-07 a timed-out current proof retires discovery", async () => {
  const { cwd, session, render } = await setup();
  const held = await holdFirstGitLookup(fsp.lstat, cwd);
  try {
    await render(menu(cwd));
    const listing = session.listDialogs();
    await held.began;
    expect(await listing).toEqual([]);
    held.release();
    await render(menu(cwd));
    expect(await session.listDialogs()).toEqual([]);
  } finally {
    held.release();
    await session.teardown();
  }
});

test.each([
  "stop",
  "host write",
  "resize",
  "composer",
] as const)("C-ATTN-07 revokes an in-flight read on %s", async (revoke) => {
  const { cwd, session, render } = await setup();
  const held = await holdFirstGitLookup(fsp.lstat, cwd);
  try {
    await render(menu(cwd));
    const listing = session.listDialogs();
    await held.began;
    if (revoke === "stop") await session.stop();
    if (revoke === "host write") await session.terminal.writeOutput("host output");
    if (revoke === "resize") await session.resize({ rows: 20, cols: 84 });
    if (revoke === "composer") await render(codexTty(codexComposer));
    await expect(
      Promise.race([listing, new Promise((resolve) => setImmediate(() => resolve("waiting")))]),
    ).resolves.toEqual([]);
    held.release();
    await render(menu(cwd));
    expect(await session.listDialogs()).toEqual([]);
  } finally {
    held.release();
    await session.teardown();
  }
});
