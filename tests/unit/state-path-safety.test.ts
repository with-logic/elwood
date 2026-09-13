/** Planted state paths must not change external files or modes (PRD §8, C-STATE-01). */
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { assertStatePath } from "../../src/state/directories.ts";
import { secureMkdir, writePrivateFile } from "../../src/state/files.ts";
import { ensurePrivateStateRoot } from "../../src/state/private-session.ts";
import { prepareStateDir } from "../../src/state/store.ts";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "elwood-path-safety-"));
  roots.push(root);
  const privateDir = join(root, "private");
  mkdirSync(privateDir, { mode: 0o700 });
  const secret = join(privateDir, "secret");
  writeFileSync(secret, "keep", { mode: 0o600 });
  return { root, privateDir, secret, state: join(root, ".elwood") };
}
test.each([
  "root",
  "sessions",
  "ancestor",
])("C-STATE-01 rejects a planted %s link before touching its target", (where) => {
  const f = fixture();
  if (where === "sessions") mkdirSync(f.state, { mode: 0o700 });
  const link = where === "sessions" ? join(f.state, "sessions") : f.state;
  symlinkSync(f.privateDir, link);
  const state = where === "ancestor" ? join(link, "nested") : f.state;
  expect(() => prepareStateDir(state, { gitignore: true })).toThrowError(
    expect.objectContaining({ code: "state_corrupt" }),
  );
  expect(statSync(f.privateDir).mode & 0o777).toBe(0o700);
  expect(readFileSync(f.secret, "utf8")).toBe("keep");
  if (where === "sessions") expect(statSync(f.state).mode & 0o777).toBe(0o700);
});
test("C-STATE-01 rejects dangling links and invalid ancestry", () => {
  const f = fixture();
  symlinkSync(join(f.root, "missing"), f.state);
  expect(() => prepareStateDir(f.state)).toThrowError(
    expect.objectContaining({ code: "state_corrupt" }),
  );
  expect(() => assertStatePath(join(f.secret, "child"))).toThrow();
});
test("C-STATE-01 generated files reject symbolic and hard links before truncating", () => {
  const f = fixture();
  for (const [name, plant] of [
    ["symbolic", symlinkSync],
    ["hard", linkSync],
  ] as const) {
    const path = join(f.root, name);
    plant(f.secret, path);
    expect(() => writePrivateFile(path, "replace")).toThrowError(
      expect.objectContaining({ code: "state_corrupt" }),
    );
    expect(readFileSync(f.secret, "utf8")).toBe("keep");
    expect(statSync(f.secret).mode & 0o777).toBe(0o600);
  }
});
test("C-STATE-01 owned existing files retain exact contents and modes", () => {
  const f = fixture();
  chmodSync(f.secret, 0o644);
  writePrivateFile(f.secret, "x");
  expect(readFileSync(f.secret, "utf8")).toBe("x");
  expect(statSync(f.secret).mode & 0o777).toBe(0o600);
});
test("C-STATE-01 rejects a directory whose owner differs from the caller", () => {
  const f = fixture();
  vi.spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
  expect(() => secureMkdir(f.privateDir)).toThrowError(
    expect.objectContaining({ code: "state_corrupt" }),
  );
  expect(statSync(f.privateDir).mode & 0o777).toBe(0o700);
});
test("C-STATE-01 CLI rejects a file in place of its root and never creates through an ancestor link", () => {
  const f = fixture();
  expect(() => ensurePrivateStateRoot(f.secret)).toThrowError(
    expect.objectContaining({ code: "state_corrupt" }),
  );
  symlinkSync(f.privateDir, f.state);
  expect(() => ensurePrivateStateRoot(join(f.state, "nested"))).toThrowError(
    expect.objectContaining({ code: "state_corrupt" }),
  );
  expect(() => statSync(join(f.privateDir, "nested"))).toThrow();
  expect(readFileSync(f.secret, "utf8")).toBe("keep");
  expect(statSync(f.privateDir).mode & 0o777).toBe(0o700);
});
