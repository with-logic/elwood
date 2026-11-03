/** Original lexical names and alias targets must all be trustworthy (C-STATE-11). */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { assertTrustedIgnoreParent as trusted } from "../../../src/state/preparation/root-trust.ts";
import { tempDir } from "../../helpers/tmp.ts";

afterEach(() => vi.restoreAllMocks());

const root = () => {
  const dir = tempDir("ignore-parent-trust-");
  chmodSync(dir, 0o700);
  return dir;
};
const child = (dir: string, name: string, mode = 0o700) => {
  const path = join(dir, name);
  mkdirSync(path, { mode });
  chmodSync(path, mode);
  return path;
};

test("C-STATE-11 ordinary, relative, dot and root-owned /tmp alias paths pass without mutations", () => {
  const dir = root();
  const parent = child(dir, ".elwood");
  const target = join(parent, ".gitignore");
  writeFileSync(target, "existing\n", { mode: 0o600 });
  trusted(parent);
  trusted(relative(process.cwd(), parent));
  trusted(`${dir}/./.elwood/../.elwood`);
  expect(readFileSync(target, "utf8")).toBe("existing\n");
  expect(statSync(target).mode & 0o777).toBe(0o600);
  const tmp = mkdtempSync("/tmp/elwood-ignore-parent-");
  try {
    trusted(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("C-STATE-11 unsafe lexical components are checked even before '..' returns to a safe directory", () => {
  const dir = root();
  child(dir, "shared", 0o777);
  const safe = child(dir, "safe");
  const parent = child(safe, ".elwood");
  trusted(parent);
  expect(() => trusted(`${dir}/shared/../safe/.elwood`)).toThrow(
    expect.objectContaining({ code: "state_corrupt" }),
  );
});

test("C-STATE-11 relative and absolute aliases inspect every target ancestor", () => {
  const dir = root();
  const safe = child(dir, "safe");
  child(safe, ".elwood");
  symlinkSync("safe", join(dir, "relative"));
  symlinkSync(safe, join(dir, "absolute"));
  trusted(join(dir, "relative", ".elwood"));
  trusted(join(dir, "absolute", ".elwood"));
  const shared = child(dir, "shared", 0o777);
  const target = child(shared, "target");
  symlinkSync(target, join(dir, "redirect"));
  expect(() => trusted(join(dir, "redirect"))).toThrow(
    expect.objectContaining({ code: "state_corrupt" }),
  );
  symlinkSync(`${dir}/shared/../safe`, join(dir, "dotdot"));
  expect(() => trusted(join(dir, "dotdot", ".elwood"))).toThrow(
    expect.objectContaining({ code: "state_corrupt" }),
  );
});

test("C-STATE-11 final parents must themselves be trusted directories", () => {
  const dir = root();
  expect(() => trusted(child(dir, ".elwood", 0o777))).toThrow(
    expect.objectContaining({ code: "state_corrupt" }),
  );
  const file = join(dir, "file");
  writeFileSync(file, "unchanged", { mode: 0o600 });
  expect(() => trusted(file)).toThrow(expect.objectContaining({ code: "state_corrupt" }));
  expect(readFileSync(file, "utf8")).toBe("unchanged");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(() => trusted(join(dir, "missing"))).toThrow(expect.objectContaining({ code: "ENOENT" }));
});

test("C-STATE-11 loops and non-UTF-8 link targets are uninspectable", () => {
  const dir = root();
  symlinkSync("loop", join(dir, "loop"));
  expect(() => trusted(join(dir, "loop"))).toThrow(
    expect.objectContaining({ code: "state_corrupt" }),
  );
  symlinkSync(Buffer.from([0xff]), join(dir, "invalid"));
  expect(() => trusted(join(dir, "invalid"))).toThrow(
    expect.objectContaining({ code: "state_corrupt" }),
  );
});

test.each(["getuid", "getgid"] as const)("C-STATE-11 missing %s fails closed", (name) => {
  const original = Object.getOwnPropertyDescriptor(process, name)!;
  delete process[name];
  try {
    expect(() => trusted(root())).toThrow(expect.objectContaining({ code: "state_corrupt" }));
  } finally {
    Object.defineProperty(process, name, original);
  }
});
