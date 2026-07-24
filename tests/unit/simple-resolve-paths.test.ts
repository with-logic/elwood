/**
 * Unit coverage for `resolveSessionPaths` (PRD §5.8): the ergonomic session snapshots `cwd` and
 * resolves any relative `stateDir` against it AT CONSTRUCTION, so a later `process.chdir()`
 * cannot move the target project or state location.
 */

import { isAbsolute, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { resolveSessionPaths } from "../../src/core/simple/resolve-paths.ts";

describe("resolveSessionPaths", () => {
  test("defaults cwd to the current directory, resolved absolute", () => {
    const out = resolveSessionPaths({});
    expect(out.cwd).toBe(resolve(process.cwd()));
    expect(isAbsolute(out.cwd)).toBe(true);
    expect("stateDir" in out).toBe(false); // omitted stateDir stays omitted
  });

  test("resolves an explicit relative cwd against the process cwd", () => {
    const out = resolveSessionPaths({ cwd: "sub/dir" });
    expect(out.cwd).toBe(resolve(process.cwd(), "sub/dir"));
  });

  test("resolves a RELATIVE stateDir against the (snapshotted) cwd", () => {
    const out = resolveSessionPaths({ cwd: "/abs/project", stateDir: ".elwood" });
    expect(out.cwd).toBe(resolve("/abs/project"));
    expect(out.stateDir).toBe(resolve("/abs/project", ".elwood"));
  });

  test("leaves an ABSOLUTE stateDir unchanged", () => {
    const out = resolveSessionPaths({ cwd: "/abs/project", stateDir: "/var/state" });
    expect(out.stateDir).toBe("/var/state");
  });

  test("preserves other options verbatim", () => {
    const out = resolveSessionPaths({ cwd: "/p", autotrust: true } as {
      cwd: string;
      autotrust: boolean;
    });
    expect(out.autotrust).toBe(true);
  });
});
