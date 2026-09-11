/**
 * Effective CLI request resolution coverage.
 * Covers PRD §12A.1/§12A.2/§12A.4 and C-CLI-03/C-CLI-04/C-CLI-06/C-CLI-14/C-CLI-21.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseCliArgs } from "../../src/cli/args/index.ts";
import { autoDetectedSource } from "../../src/cli/request/agent-detect.ts";
import { finalizeRunRequest, resolveRunRequest } from "../../src/cli/request/index.ts";
import { detectCodex } from "./agent-fakes.ts";

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

  test("C-CLI-14 negative flags and no-defaults make inherited settings reversible", async () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-cli-request-"));
    const configPath = join(root, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ schemaVersion: 1, agent: "claude", verbose: true, stream: true }),
      { mode: 0o600 },
    );
    const inherited = parseCliArgs(["--output", "json", "--no-stream", "--no-verbose", "go"]);
    const isolated = parseCliArgs(["--no-defaults", "go"]);
    if (inherited.command !== "run" || isolated.command !== "run") throw new Error("expected run");
    const context = {
      env: { ELWOOD_CONFIG: configPath, ELWOOD_AGENT: "claude", ELWOOD_STREAM: "true" },
      homeDir: root,
      invocationCwd: root,
      stdin: { isTTY: true, source: stdin() },
    } as const;
    await expect(resolveRunRequest(inherited, context)).resolves.toMatchObject({
      agent: "claude",
      output: "json",
      stream: false,
      verbose: false,
    });
    const detected = await resolveRunRequest(isolated, context, detectCodex);
    expect(detected).toMatchObject({
      agent: "codex",
      output: "text",
      stream: false,
      verbose: false,
    });
    expect(detected.resolution?.sources.agent).toBe(autoDetectedSource);
  });

  test("C-CLI-20 incompatibility errors identify inherited sources and recovery flags", async () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-cli-request-"));
    const context = {
      env: { ELWOOD_STREAM: "true" },
      homeDir: root,
      invocationCwd: root,
      stdin: { isTTY: true, source: stdin() },
    } as const;
    const parsed = parseCliArgs(["--output", "json", "go"]);
    if (parsed.command !== "run") throw new Error("expected run");
    await expect(resolveRunRequest(parsed, context, detectCodex)).rejects.toThrow(
      "Streaming is enabled by ELWOOD_STREAM; JSON output requires streaming to be disabled. Use --no-stream.",
    );
  });

  test("C-CLI-19 provenance distinguishes positive flags and environment values", async () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-cli-request-"));
    const flagged = parseCliArgs(["--trust", "--debug", "go"]);
    const inherited = parseCliArgs(["go"]);
    if (flagged.command !== "run" || inherited.command !== "run") throw new Error("expected run");
    const first = await resolveRunRequest(
      flagged,
      { env: {}, homeDir: root, invocationCwd: root, stdin: { isTTY: true, source: stdin() } },
      detectCodex,
    );
    const second = await resolveRunRequest(
      inherited,
      {
        env: { ELWOOD_TRUST: "false" },
        homeDir: root,
        invocationCwd: root,
        stdin: { isTTY: true, source: stdin() },
      },
      detectCodex,
    );
    expect(first.resolution?.sources).toMatchObject({ trust: "--trust", debug: "--debug" });
    expect(second.resolution?.sources.trust).toBe("ELWOOD_TRUST");
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
    const draft = await resolveRunRequest(
      parsed,
      { env: {}, homeDir: root, invocationCwd: root, stdin: { isTTY: true, source: stdin() } },
      detectCodex,
    );
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
    const draft = await resolveRunRequest(
      parsed,
      { env: {}, homeDir: root, invocationCwd: root, stdin: { isTTY: true, source: stdin() } },
      detectCodex,
    );
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
    await expect(resolveRunRequest(structured, context, detectCodex)).rejects.toThrow(/stream/iu);
    for (const headed of [headedStream, headedVerbose, headedJsonl]) {
      if (headed.command !== "run") throw new Error("expected headed run");
      await expect(resolveRunRequest(headed, context, detectCodex)).rejects.toThrow(/head/iu);
    }
  });
});
