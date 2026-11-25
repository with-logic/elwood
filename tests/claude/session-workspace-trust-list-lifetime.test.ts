/** Bound Claude Git evidence reads and check list lifetime through the session API (C-ATTN-07). */
import { realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, assert, expect, test, vi } from "vitest";
import { type ClaudeSessionApi, startClaude } from "../../src/index.ts";
import { claudeComposer, claudeTty } from "../fixtures/trust-composer.ts";
import { holdFirstGitLookup } from "../helpers/hold-git-lookup.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";
import { trustFrame } from "./workspace-trust-discovery-fixture.ts";

vi.mock("node:fs/promises", { spy: true });
afterEach(() => {
  vi.mocked(fs.lstat).mockReset();
  vi.restoreAllMocks();
  resetFakes();
});

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

async function waitForAnnouncement(session: ClaudeSessionApi, render: () => Promise<void>) {
  const announced = Promise.withResolvers<void>();
  const unsubscribe = session.on("dialog", (event) => {
    if (event.phase === "raised") announced.resolve();
  });
  try {
    await render();
    await announced.promise;
  } finally {
    unsubscribe();
  }
}

test("C-ATTN-07 a stalled Claude launch proof leaves the native gate intact", async () => {
  installFakes();
  const cwd = realpathSync(tempDir());
  const held = await holdFirstGitLookup(fs.lstat, cwd);
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
  await waitForAnnouncement(session, render);
  const held = await holdFirstGitLookup(fs.lstat, cwd);
  try {
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
  await waitForAnnouncement(session, render);
  const held = await holdFirstGitLookup(fs.lstat, cwd);
  try {
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
  await waitForAnnouncement(session, render);
  const held = await holdFirstGitLookup(fs.lstat, cwd);
  try {
    const first = session.listDialogs();
    await held.began;
    const second = session.listDialogs();
    held.release();
    const [[a], [b]] = await Promise.all([first, second]);
    assert.isDefined(a);
    assert.isDefined(b);
    expect(b.id).toBe(a.id);
    expect(b.choices.map(({ id }) => id)).toEqual(a.choices.map(({ id }) => id));
    expect(
      vi.mocked(fs.lstat).mock.calls.filter(([path]) => path === join(cwd, ".git")),
    ).toHaveLength(1);
  } finally {
    held.release();
    await session.teardown();
  }
});

test.each<{
  readonly name: string;
  readonly revoke: (context: Awaited<ReturnType<typeof setup>>) => Promise<void>;
}>([
  { name: "stop", revoke: ({ session }) => session.stop() },
  { name: "host write", revoke: ({ session }) => session.terminal.writeOutput("host output") },
  { name: "resize", revoke: ({ session }) => session.resize({ rows: 20, cols: 102 }) },
  { name: "composer", revoke: ({ render }) => render(`\x1b[2J\x1b[H${claudeTty(claudeComposer)}`) },
])("C-ATTN-07 a Claude list drops its in-flight proof on $name", async ({ revoke }) => {
  const context = await setup();
  const { cwd, session, render } = context;
  await waitForAnnouncement(session, render);
  const held = await holdFirstGitLookup(fs.lstat, cwd);
  try {
    const reading = session.listDialogs();
    await held.began;
    await revoke(context);
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
