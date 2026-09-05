/**
 * Effective CLI request resolution coverage.
 * Covers PRD §12A.1/§12A.2/§12A.4 and C-CLI-03/C-CLI-04/C-CLI-06/C-CLI-14.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseCliArgs } from "../../src/cli/args.ts";
import { finalizeRunRequest, resolveRunRequest } from "../../src/cli/request.ts";

async function* stdin(value = "") {
  await Promise.resolve();
  if (value !== "") yield value;
}

describe("effective CLI request", () => {
  test("C-CLI-14 applies flag > env > config > built-in precedence", async () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-cli-request-"));
    const configPath = join(root, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ schemaVersion: 1, agent: "claude", timeout: "3m", trust: false }),
      { mode: 0o600 },
    );
    const parsed = parseCliArgs(["--agent", "codex", "--timeout", "5m", "prompt"]);
    if (parsed.command !== "run") throw new Error("expected run");
    const draft = await resolveRunRequest(parsed, {
      env: { ELWOOD_CONFIG: configPath, ELWOOD_AGENT: "claude", ELWOOD_TIMEOUT: "4m" },
      homeDir: root,
      invocationCwd: root,
      stdin: { isTTY: false, source: stdin() },
    });
    expect(draft).toMatchObject({ agent: "codex", timeoutMs: 300_000, trust: false });
  });

  test("C-CLI-03/C-CLI-04 finalizes cwd and ordered images before launch", async () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-cli-request-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "a.png"), "a");
    writeFileSync(join(workspace, "b.png"), "b");
    const parsed = parseCliArgs([
      "-C",
      "workspace",
      "--head",
      "--image",
      "a.png",
      "--image",
      "b.png",
      "go",
    ]);
    if (parsed.command !== "run") throw new Error("expected run");
    const draft = await resolveRunRequest(parsed, {
      env: {},
      homeDir: root,
      invocationCwd: root,
      stdin: { isTTY: true, source: stdin() },
    });
    const request = await finalizeRunRequest(draft);
    expect(request.cwd).toBe(workspace);
    expect(request.images).toEqual([
      { path: join(workspace, "a.png") },
      { path: join(workspace, "b.png") },
    ]);
    expect("head" in request).toBe(false);
  });

  test("C-CLI-03 snapshots the invocation cwd for a new session", async () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-cli-request-"));
    const parsed = parseCliArgs(["go"]);
    if (parsed.command !== "run") throw new Error("expected run");
    const draft = await resolveRunRequest(parsed, {
      env: {},
      homeDir: root,
      invocationCwd: root,
      stdin: { isTTY: true, source: stdin() },
    });
    await expect(finalizeRunRequest(draft)).resolves.toMatchObject({ cwd: root });
  });

  test("C-CLI-06 rejects adapter-specific and output incompatibilities", async () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-cli-request-"));
    const context = {
      env: {},
      homeDir: root,
      invocationCwd: root,
      stdin: { isTTY: true, source: stdin() },
    } as const;
    const incompatible = parseCliArgs([
      "--agent",
      "codex",
      "--claude-permission-mode",
      "plan",
      "go",
    ]);
    const structured = parseCliArgs(["--output", "json", "--stream", "go"]);
    const headedStream = parseCliArgs(["--head", "--stream", "go"]);
    const headedVerbose = parseCliArgs(["--head", "--verbose", "go"]);
    const headedJsonl = parseCliArgs(["--head", "--output", "jsonl", "go"]);
    if (incompatible.command !== "run" || structured.command !== "run") {
      throw new Error("expected runs");
    }
    await expect(resolveRunRequest(incompatible, context)).rejects.toThrow(/Claude/iu);
    await expect(resolveRunRequest(structured, context)).rejects.toThrow(/stream/iu);
    for (const headed of [headedStream, headedVerbose, headedJsonl]) {
      if (headed.command !== "run") throw new Error("expected headed run");
      await expect(resolveRunRequest(headed, context)).rejects.toThrow(/head/iu);
    }
  });
});
