/** Deterministic state rollback races preserve directories another setup created (C-STATE-14). */
import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ensurePrivateStateRoot } from "../../src/state/private-session.ts";
import { prepareStateDir } from "../../src/state/store.ts";
import { tempDir } from "../helpers/tmp.ts";

type FaultMode = "construction" | "late" | "replacement";
const race = vi.hoisted(() => ({
  target: "",
  cwd: "",
  mode: "late" as FaultMode,
  raced: false,
  rootFd: undefined as number | undefined,
  actorIdentity: undefined as { readonly dev: bigint; readonly ino: bigint } | undefined,
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    mkdirSync: (...args: Parameters<typeof actual.mkdirSync>) => {
      const path = String(args[0]);
      if (path === race.target && !race.raced && race.mode !== "replacement") {
        // Another actor wins after makeStateTree's absence check, before our mkdir.
        actual.mkdirSync(path, { mode: 0o700 });
        race.raced = true;
        const { dev, ino } = actual.statSync(path, { bigint: true });
        race.actorIdentity = { dev, ino };
      }
      const result = actual.mkdirSync(...args);
      if (race.mode === "late" && path === join(race.target, "sessions"))
        actual.rmSync(race.cwd, { recursive: true });
      return result;
    },
    realpathSync: Object.assign((path: string) => actual.realpathSync(path), {
      native: (path: string) => {
        if (
          race.mode === "replacement" &&
          path === race.cwd &&
          actual.existsSync(join(race.target, "sessions"))
        ) {
          actual.renameSync(race.target, `${race.target}-original`);
          actual.mkdirSync(race.target);
          const { dev, ino } = actual.statSync(race.target, { bigint: true });
          race.actorIdentity = { dev, ino };
          race.raced = true;
          actual.rmSync(race.cwd, { recursive: true });
        }
        return actual.realpathSync.native(path);
      },
    }),
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...args);
      if (String(args[0]) === race.target) race.rootFd = fd;
      return fd;
    },
    fstatSync: (...args: Parameters<typeof actual.fstatSync>) => {
      const info = actual.fstatSync(...args);
      if (race.mode !== "construction" || args[0] !== race.rootFd) return info;
      // Model another account's ownership without requiring privileged chown.
      return new Proxy(info, {
        get: (target, key) => (key === "uid" ? Number(info.uid) + 1 : Reflect.get(target, key)),
      });
    },
    closeSync: (fd: number) => {
      if (fd === race.rootFd) race.rootFd = undefined;
      actual.closeSync(fd);
    },
  };
});
afterEach(() =>
  Object.assign(race, {
    target: "",
    cwd: "",
    raced: false,
    rootFd: undefined,
    actorIdentity: undefined,
  }),
);

for (const [api, setup] of [
  ["session", (state: string, cwd: string) => prepareStateDir(state, { cwd })],
  ["CLI", ensurePrivateStateRoot],
] as const)
  test.each([
    "construction",
    "late",
    "replacement",
  ] as const)(`C-STATE-14 ${api} %s failure preserves another actor's custom directory identity`, (mode) => {
    const root = tempDir("elwood-state-ownership-race-");
    const cwd = join(root, "project");
    const state = join(root, "custom");
    fs.mkdirSync(cwd);
    Object.assign(race, { target: state, cwd, mode });
    expect(() => setup(state, cwd)).toThrow();
    expect(race.raced).toBe(true);
    expect(fs.existsSync(state)).toBe(true);
    const identity = race.actorIdentity;
    if (identity === undefined) throw new Error("The other actor never created its directory.");
    expect(fs.statSync(state, { bigint: true })).toMatchObject(identity);
  });
