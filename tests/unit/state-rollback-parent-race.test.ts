/** Public rollback preserves entries under replaceable ancestors (PRD §8.1, C-STATE-14). */
import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { ensurePrivateStateRoot } from "../../src/state/private-session.ts";
import { prepareStateDir } from "../../src/state/store.ts";

const race = vi.hoisted(() => ({
  cwd: "",
  ancestor: "",
  replacement: "",
  leaf: "",
  ready: false,
  swapped: false,
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    realpathSync: Object.assign((path: string) => actual.realpathSync(path), {
      native: (path: string) => {
        if (path === race.cwd && actual.existsSync(race.leaf)) {
          actual.rmdirSync(path);
          race.ready = true;
        }
        return actual.realpathSync.native(path);
      },
    }),
    rmdirSync: (path: string) => {
      if (race.ready && race.replacement !== "" && path === race.leaf && !race.swapped) {
        actual.renameSync(race.ancestor, `${race.ancestor}-original`);
        actual.renameSync(race.replacement, race.ancestor);
        race.swapped = true;
      }
      actual.rmdirSync(path);
    },
  };
});
afterEach(() =>
  Object.assign(race, {
    cwd: "",
    ancestor: "",
    replacement: "",
    leaf: "",
    ready: false,
    swapped: false,
  }),
);

for (const [api, setup] of [
  ["session", (state: string, cwd: string) => prepareStateDir(state, { cwd })],
  ["CLI", ensurePrivateStateRoot],
] as const) {
  test.each([
    0o777, 0o755, 0o1777,
  ])(`C-STATE-14 ${api} rollback respects ancestor mode %i`, (mode) => {
    // /tmp is traversable by other accounts; the fixture root is searchable too.
    const root = fs.mkdtempSync("/tmp/elwood-rollback-parent-");
    onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.chmodSync(root, 0o755);
    const shared = join(root, "shared");
    fs.mkdirSync(shared);
    fs.chmodSync(shared, mode);
    const cwd = join(root, "project");
    fs.mkdirSync(cwd);
    const ancestor = join(shared, "ancestor");
    fs.mkdirSync(ancestor);
    const state = join(ancestor, "state");
    const leaf = join(state, "sessions");
    const replacement = join(shared, "replacement");
    const unrelated = join(replacement, "state", "sessions");
    fs.mkdirSync(unrelated, { recursive: true });
    const identity = fs.lstatSync(unrelated, { bigint: true });
    Object.assign(race, { cwd, ancestor, leaf, replacement: mode === 0o777 ? replacement : "" });
    expect(() => setup(state, cwd)).toThrow(expect.objectContaining({ code: "ENOENT" }));
    expect(race.ready).toBe(true);
    if (mode === 0o777) {
      const preserved = race.swapped ? leaf : unrelated;
      expect(fs.existsSync(preserved), "unrelated empty directory must survive").toBe(true);
      expect(fs.lstatSync(preserved, { bigint: true })).toMatchObject({
        dev: identity.dev,
        ino: identity.ino,
      });
    } else
      expect(fs.existsSync(state), "trusted ordinary and sticky parents allow rollback").toBe(
        false,
      );
  });
}
