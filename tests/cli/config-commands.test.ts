/**
 * Global config command behavior and shell-output tests (PRD §12A.4, C-CLI-14/C-CLI-15).
 */

import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runConfigCommand } from "../../src/cli/config/commands.ts";
import { AsyncOutputSink } from "../../src/cli/stream.ts";
import { CliValidationError } from "../../src/cli/types.ts";
import { MemoryWriter } from "./run-fakes.ts";

function harness() {
  const root = mkdtempSync(join(tmpdir(), "elwood-config-command-"));
  const path = join(root, "nested", "config.json");
  const writer = new MemoryWriter();
  const stdout = new AsyncOutputSink(writer);
  const context = {
    env: { ELWOOD_CONFIG: path },
    invocationCwd: root,
    homeDir: root,
    stdout,
  };
  return { root, path, writer, stdout, context };
}

describe("config commands", () => {
  test("C-CLI-14 path and absent show are deterministic", async () => {
    const h = harness();
    await runConfigCommand(["path"], h.context);
    expect(h.writer.value).toBe(`${h.path}\n`);
    h.writer.value = "";
    await runConfigCommand(["show"], h.context);
    expect(h.writer.value).toBe('{\n  "schemaVersion": 1\n}\n');
    expect(existsSync(h.path)).toBe(false);
  });

  test("C-CLI-14 set/get/unset use typed dotted values and silent writes", async () => {
    const h = harness();
    await runConfigCommand(["set", "agent", "claude"], h.context);
    await runConfigCommand(["set", "verbose", "true"], h.context);
    await runConfigCommand(["set", "claude.model", "sonnet"], h.context);
    expect(h.writer.value).toBe("");
    expect(statSync(h.path).mode & 0o777).toBe(0o600);
    await runConfigCommand(["get", "agent"], h.context);
    await runConfigCommand(["get", "verbose"], h.context);
    await runConfigCommand(["get", "claude.model"], h.context);
    expect(h.writer.value).toBe("claude\ntrue\nsonnet\n");
    h.writer.value = "";
    await runConfigCommand(["unset", "claude.model"], h.context);
    await runConfigCommand(["unset", "claude.model"], h.context);
    await runConfigCommand(["get", "claude.model"], h.context);
    expect(h.writer.value).toBe("");
    expect(JSON.parse(readFileSync(h.path, "utf8"))).toEqual({
      schemaVersion: 1,
      agent: "claude",
      verbose: true,
    });
  });

  test.each(
    [
      [],
      ["unknown"],
      ["path", "extra"],
      ["show", "extra"],
      ["get"],
      ["get", ""],
      ["get", "agent", "extra"],
      ["set", "agent"],
      ["set", "agent", ""],
      ["unset"],
    ].map((args) => ({ args })),
  )("rejects malformed config arguments: $args", async ({ args }) => {
    const h = harness();
    await expect(runConfigCommand(args, h.context)).rejects.toBeInstanceOf(CliValidationError);
  });
});
