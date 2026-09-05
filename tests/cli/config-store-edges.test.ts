/** Filesystem-failure coverage for private CLI config storage. Covers PRD C-CLI-15. */

import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";

const fault = vi.hoisted(() => ({ mode: "none" }));

vi.mock("node:crypto", () => ({ randomUUID: () => "fixed" }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    lstatSync: (path: Parameters<typeof actual.lstatSync>[0]) => {
      if (fault.mode === "inspect") throw new Error("inspect failed");
      return actual.lstatSync(path);
    },
    openSync: (path: Parameters<typeof actual.openSync>[0], flags: number, mode?: number) => {
      if (fault.mode === "open" && String(path).endsWith(".tmp-fixed")) {
        throw new Error("open failed");
      }
      if (fault.mode === "read" && String(path).endsWith("read-error.json")) {
        throw new Error("read failed");
      }
      return actual.openSync(path, flags, mode);
    },
    writeFileSync: (file: Parameters<typeof actual.writeFileSync>[0], data: string) => {
      if (fault.mode === "write" && typeof file === "number") throw new Error("write failed");
      return actual.writeFileSync(file, data);
    },
  };
});

import { readConfig, writeConfig } from "../../src/cli/config/store.ts";

const root = () => mkdtempSync(join(tmpdir(), "elwood-config-fault-"));
const config = { schemaVersion: 1 } as const;

describe("CLI config store failures", () => {
  test.each(["open", "write"])("contains an atomic %s failure", (mode) => {
    const path = join(root(), "config.json");
    fault.mode = mode;
    expect(() => writeConfig(path, config)).toThrow(/safely write/iu);
    fault.mode = "none";
  });

  test("normalizes target-inspection and read failures", () => {
    const directory = root();
    fault.mode = "inspect";
    expect(() => writeConfig(join(directory, "config.json"), config)).toThrow(/inspect/iu);
    fault.mode = "read";
    expect(() => readConfig(join(directory, "read-error.json"))).toThrow(/safely read/iu);
    fault.mode = "none";
  });

  test("rejects an existing symlink before atomic replacement", () => {
    const directory = root();
    const real = join(directory, "real.json");
    const link = join(directory, "link.json");
    writeFileSync(real, '{"schemaVersion":1}\n', { mode: 0o600 });
    symlinkSync(real, link);
    expect(() => writeConfig(link, config)).toThrow(/regular file/iu);
  });
});
