/**
 * Global CLI config codec, path, and filesystem-safety coverage.
 * Covers PRD §12A.4 and C-CLI-13/C-CLI-15.
 */

import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { decodeConfig, parseConfigValue, setConfigValue } from "../../src/cli/config/codec.ts";
import { resolveConfigPath, resolveStateLocation } from "../../src/cli/config/paths.ts";
import { readConfig, writeConfig } from "../../src/cli/config/store.ts";
import { CliValidationError } from "../../src/cli/types.ts";

const sandbox = () => mkdtempSync(join(tmpdir(), "elwood-cli-config-"));

describe("CLI config", () => {
  test("C-CLI-13 resolves explicit, absolute XDG, relative-XDG, and home fallbacks", () => {
    const cwd = "/work";
    const home = "/home/me";
    expect(resolveConfigPath({ ELWOOD_CONFIG: "custom.json" }, cwd, home)).toBe(
      "/work/custom.json",
    );
    expect(resolveConfigPath({ XDG_CONFIG_HOME: "/cfg" }, cwd, home)).toBe(
      "/cfg/elwood/config.json",
    );
    expect(resolveConfigPath({ XDG_CONFIG_HOME: "relative" }, cwd, home)).toBe(
      "/home/me/.config/elwood/config.json",
    );
    expect(resolveStateLocation({ XDG_STATE_HOME: "/state" }, home)).toEqual({
      path: "/state/elwood",
      source: "XDG_STATE_HOME",
    });
    expect(resolveStateLocation({ XDG_STATE_HOME: "relative" }, home)).toEqual({
      path: "/home/me/.local/state/elwood",
      source: "home directory",
    });
  });

  test("C-CLI-13 decodes only the strict v1 shape", () => {
    expect(
      decodeConfig({
        schemaVersion: 1,
        agent: "claude",
        trust: false,
        claude: { permissionMode: "dontAsk", reasoningEffort: "high" },
      }),
    ).toMatchObject({ agent: "claude", trust: false });
    expect(() => decodeConfig({ schemaVersion: 2 })).toThrow(/schemaVersion/iu);
    expect(() => decodeConfig({ schemaVersion: 1, prompt: "forbidden" })).toThrow(/prompt/iu);
    expect(() => decodeConfig({ schemaVersion: 1, claude: { sandbox: "read-only" } })).toThrow(
      /sandbox/iu,
    );
  });

  test("C-CLI-14 parses typed dotted values", () => {
    expect(parseConfigValue("trust", "false")).toBe(false);
    expect(parseConfigValue("timeout", "5m")).toBe("5m");
    expect(() => parseConfigValue("trust", "yes")).toThrow(/true.*false/iu);
    expect(setConfigValue({ schemaVersion: 1 }, "codex.sandbox", "read-only")).toEqual({
      schemaVersion: 1,
      codex: { sandbox: "read-only" },
    });
  });

  test("C-CLI-15 writes an atomic private regular file and reads it", () => {
    const root = sandbox();
    const path = join(root, "nested", "config.json");
    writeConfig(path, { schemaVersion: 1, agent: "codex" });
    expect(readConfig(path)).toEqual({ schemaVersion: 1, agent: "codex" });
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toMatch(/"schemaVersion": 1/u);
  });

  test("C-CLI-20 identifies the selected path for malformed config", () => {
    const path = join(sandbox(), "malformed.json");
    writeFileSync(path, "not JSON\n", { mode: 0o600 });
    const error = readError(path);
    expect(error.code).toBe("invalid_config");
    expect(error.message).toBe(`Elwood config ${JSON.stringify(path)}: Config is not valid JSON.`);
  });

  test.each(["symlink", "permissive", "wrong-owner"])("C-CLI-15 rejects %s config", (variant) => {
    const root = sandbox();
    const real = join(root, "real.json");
    writeFileSync(real, '{"schemaVersion":1}\n', { mode: 0o600 });
    let path = real;
    let uid = lstatSync(real).uid;
    if (variant === "symlink") {
      path = join(root, "link.json");
      symlinkSync(real, path);
    } else if (variant === "permissive") {
      chmodSync(path, 0o640);
    } else {
      uid += 1;
    }
    const error = readError(path, uid);
    expect(error.code).toBe("invalid_config");
    expect(error.message).toContain(`Elwood config ${JSON.stringify(path)}`);
    expect(error.message).toMatch(
      variant === "symlink"
        ? /could not be safely read|regular file, not a symlink/iu
        : variant === "permissive"
          ? /permissions must be owner-only/iu
          : /owned by the current user/iu,
    );
  });
});

function readError(path: string, uid = process.getuid!()): CliValidationError {
  try {
    readConfig(path, { uid });
  } catch (error) {
    if (error instanceof CliValidationError) return error;
    throw error;
  }
  throw new Error("Expected config read to fail.");
}
