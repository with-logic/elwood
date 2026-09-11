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
      if (fault.mode === "write" && typeof file === "number")
        throw Object.assign(new Error("write failed"), { code: "EACCES" });
      return actual.writeFileSync(file, data);
    },
  };
});

import { readConfig, writeConfig } from "../../src/cli/config/store.ts";
import { CliValidationError } from "../../src/cli/types.ts";

const root = () => mkdtempSync(join(tmpdir(), "elwood-config-fault-"));
const config = { schemaVersion: 1 } as const;

describe("CLI config store failures", () => {
  test.each([
    ["open", ""],
    ["write", " (EACCES)"],
  ])("C-CLI-20 contains an atomic %s failure naming the path and errno", (mode, code) => {
    const path = join(root(), "config.json");
    fault.mode = mode;
    expect(() => writeConfig(path, config)).toThrow(
      `Elwood config ${JSON.stringify(path)} could not be safely written${code}.`,
    );
    fault.mode = "none";
  });

  test("C-CLI-15/C-CLI-20 normalizes target-inspection and read failures", () => {
    const directory = root();
    fault.mode = "inspect";
    expect(() => writeConfig(join(directory, "config.json"), config)).toThrow(/inspect/iu);
    fault.mode = "read";
    const path = join(directory, "read-error.json");
    const error = readError(path);
    expect(error).toMatchObject({
      code: "invalid_config",
      message: `Elwood config ${JSON.stringify(path)} could not be safely read.`,
    });
    fault.mode = "none";
  });

  test("C-CLI-15 rejects an existing symlink before atomic replacement", () => {
    const directory = root();
    const real = join(directory, "real.json");
    const link = join(directory, "link.json");
    writeFileSync(real, '{"schemaVersion":1}\n', { mode: 0o600 });
    symlinkSync(real, link);
    expect(() => writeConfig(link, config)).toThrow(/regular file/iu);
  });
});

function readError(path: string): CliValidationError {
  try {
    readConfig(path);
  } catch (error) {
    if (error instanceof CliValidationError) return error;
    throw error;
  }
  throw new Error("Expected config read to fail.");
}
