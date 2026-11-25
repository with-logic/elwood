/** Bound Claude Git evidence reads and check list lifetime through the session API (C-ATTN-07). */
import { realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { startClaude } from "../../src/index.ts";
import { claudeComposer, claudeTty } from "../fixtures/trust-composer.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";
import { trustFrame } from "./workspace-trust-discovery-fixture.ts";

vi.mock("node:fs/promises", { spy: true });
afterEach(() => {
  vi.restoreAllMocks();
  resetFakes();
});

async function holdFirstGitLookup(cwd: string) {
  const began = Promise.withResolvers<void>();
  const waiting = Promise.withResolvers<void>();
  const { lstat } = await vi.importActual<typeof fs>("node:fs/promises");
  const lookup = join(cwd, ".git");
  let first = true;
  vi.mocked(fs.lstat)
    .mockClear()
    .mockImplementation(async (...options) => {
      if (first && options[0] === lookup) {
        first = false;
        began.resolve();
        await waiting.promise;
      }
      return Reflect.apply(lstat, undefined, options);
    });
  return { began: began.promise, release: waiting.resolve };
}

async function setup() {
  installFakes();
  const cwd = realpathSync(tempDir());
  const session = await startClaude({ cwd });
  const menu = trustFrame(cwd);
  const render = async (data = menu) => {
    ptys[0]!.emitData(data);
    await session.terminal.settled();
  };
  return { cwd, session, menu, render };
}

test("C-ATTN-07 a stalled Claude launch proof leaves the native gate intact", async () => {
  installFakes();
  const cwd = realpathSync(tempDir());
  const held = await holdFirstGitLookup(cwd);
  const starting = startClaude({ cwd });
  try {
    expect(await Promise.race([held.began.then(() => "proof"), starting.then(() => "pty")])).toBe(
      "proof",
    );
    expect(ptys).toHaveLength(0);
    const session = await starting;
    ptys[0]!.emitData(trustFrame(cwd));
    await session.terminal.settled();
    expect(session.status).toBe("blocked");
    expect(await session.listDialogs()).toEqual([]);
    expect(ptys[0]!.writes).toEqual([]);
  } finally {
    held.release();
    await (await starting).teardown();
  }
});

test("C-ATTN-07 a timed-out current Claude proof retires discovery", async () => {
  const { cwd, session, render } = await setup();
  const held = await holdFirstGitLookup(cwd);
  try {
    await render();
    const reading = session.listDialogs();
    await held.began;
    expect(await reading).toEqual([]);
    held.release();
    await render();
    expect(await session.listDialogs()).toEqual([]);
  } finally {
    held.release();
    await session.teardown();
  }
});

test("C-ATTN-07 a superseded Claude proof leaves a newer frame eligible", async () => {
  const { cwd, session, menu, render } = await setup();
  const held = await holdFirstGitLookup(cwd);
  try {
    await render();
    const reading = session.listDialogs();
    await held.began;
    await render(menu.replace("❯ No", "  No").replace("   Yes", " ❯ Yes"));
    const nextTurn = new Promise((resolve) => setImmediate(() => resolve("waiting")));
    await expect(Promise.race([session.listDialogs(), nextTurn])).resolves.toEqual([]);
    expect(await reading).toEqual([]);
    expect(await session.listDialogs()).toHaveLength(1);
  } finally {
    held.release();
    await session.teardown();
  }
});

test("C-ATTN-07 parallel Claude list calls share proof for the same native frame", async () => {
  const { cwd, session, render } = await setup();
  const held = await holdFirstGitLookup(cwd);
  try {
    await render();
    const first = session.listDialogs();
    await held.began;
    const second = session.listDialogs();
    held.release();
    const [[a], [b]] = await Promise.all([first, second]);
    expect(a).toBeDefined();
    expect(b).toBe(a);
    expect(
      vi.mocked(fs.lstat).mock.calls.filter(([path]) => path === join(cwd, ".git")),
    ).toHaveLength(1);
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
] as const)("C-ATTN-07 a Claude list drops its in-flight proof on %s", async (revoke) => {
  const { cwd, session, render } = await setup();
  const held = await holdFirstGitLookup(cwd);
  try {
    await render();
    const reading = session.listDialogs();
    await held.began;
    if (revoke === "stop") await session.stop();
    if (revoke === "host write") await session.terminal.writeOutput("host output");
    if (revoke === "resize") await session.resize({ rows: 20, cols: 102 });
    if (revoke === "composer") await render(`\x1b[2J\x1b[H${claudeTty(claudeComposer)}`);
    const nextTurn = new Promise((resolve) => setImmediate(() => resolve("waiting")));
    await expect(Promise.race([reading, nextTurn])).resolves.toEqual([]);
    held.release();
    await render();
    expect(await session.listDialogs()).toEqual([]);
  } finally {
    held.release();
    await session.teardown();
  }
});
