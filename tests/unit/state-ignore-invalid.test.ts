/** Reject unsafe existing/racing ignore entries without touching targets (PRD §8.1, C-STATE-01/11). */
import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { prepareStateDir } from "../../src/state/store.ts";
import { tempDir } from "../helpers/tmp.ts";

type IgnoreKind = "" | "symlink" | "dangling" | "directory";
type EntryTiming = "existing" | "racing";
const fault = vi.hoisted((): { kind: IgnoreKind; target: string; close: boolean; fd: number } => ({
  kind: "",
  target: "",
  close: false,
  fd: -1,
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...args);
      if (String(args[0]).endsWith(".pending")) fault.fd = fd;
      return fd;
    },
    closeSync: (fd: number) => {
      actual.closeSync(fd);
      if (fault.close && fd === fault.fd)
        throw Object.assign(new Error("close"), { code: "EACCES" });
    },
    linkSync: (source: string, destination: string) => {
      const kind = fault.kind;
      fault.kind = "";
      if (kind === "directory") actual.mkdirSync(destination);
      else if (kind !== "") actual.symlinkSync(fault.target, destination);
      return actual.linkSync(source, destination);
    },
  };
});
afterEach(() => Object.assign(fault, { kind: "", target: "", close: false, fd: -1 }));

describe.each([
  "existing",
  "racing",
] satisfies readonly EntryTiming[])("%s ignore entries", (when) => {
  test.each(["symlink", "dangling", "directory"] satisfies readonly Exclude<
    IgnoreKind,
    ""
  >[])("C-STATE-01 rejects %s", (kind) => {
    const cwd = tempDir("elwood-ignore-invalid-");
    const root = join(cwd, ".elwood");
    const path = join(root, ".gitignore");
    fs.mkdirSync(root);
    fault.target = join(cwd, "target");
    if (kind !== "dangling") fs.writeFileSync(fault.target, "keep", { mode: 0o600 });
    if (when === "racing") fault.kind = kind;
    else if (kind === "directory") fs.mkdirSync(path);
    else fs.symlinkSync(fault.target, path);
    expect(() => prepareStateDir(root, { cwd, isImplicitDefaultStateDir: true })).toThrow(
      expect.objectContaining({ code: "state_corrupt" }),
    );
    if (kind === "dangling") expect(fs.existsSync(fault.target)).toBe(false);
    else {
      expect(fs.readFileSync(fault.target, "utf8")).toBe("keep");
      expect(fs.statSync(fault.target).mode & 0o777).toBe(0o600);
    }
    expect(fs.existsSync(join(root, "sessions"))).toBe(true); // shared setup scaffolding is retained
  });
});

test("C-STATE-01 typed validation failure retains close cleanup diagnostics", () => {
  const cwd = tempDir("elwood-ignore-invalid-close-");
  const root = join(cwd, ".elwood");
  fault.kind = "dangling";
  fault.target = join(cwd, "absent");
  fault.close = true;
  expect(() => prepareStateDir(root, { cwd, isImplicitDefaultStateDir: true })).toThrow(
    expect.objectContaining({ code: "state_corrupt", details: { cleanupErrorCode: "EACCES" } }),
  );
});
