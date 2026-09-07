/** Source-aware CLI setting conflicts. Covers PRD C-CLI-03/C-CLI-06/C-CLI-20. */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseCliArgs } from "../../src/cli/args.ts";
import {
  finalizeRunRequest,
  resolveRunRequest,
  resolveRunSettings,
} from "../../src/cli/request.ts";
import type { ParsedRunCommand, RequestContext } from "../../src/cli/types.ts";

async function* emptyStdin(...values: readonly string[]) {
  await Promise.resolve();
  for (const value of values) yield value;
}

function root(): string {
  return mkdtempSync(join(tmpdir(), "elwood-request-conflict-"));
}

function run(argv: readonly string[]): ParsedRunCommand {
  const parsed = parseCliArgs(argv);
  if (parsed.command !== "run") throw new Error("expected run");
  return parsed;
}

function context(
  cwd: string,
  env: Readonly<Record<string, string | undefined>> = {},
): RequestContext {
  return { env, homeDir: cwd, invocationCwd: cwd, stdin: { isTTY: true, source: emptyStdin() } };
}

describe("source-aware setting conflicts", () => {
  test.each([
    [
      ["--agent", "claude", "--codex-sandbox", "read-only", "go"],
      {},
      "--codex-sandbox is incompatible with Claude. Remove --codex-sandbox.",
    ],
    [
      ["--agent", "claude", "--codex-approval-policy", "on-request", "go"],
      {},
      "--codex-approval-policy is incompatible with Claude. Remove --codex-approval-policy.",
    ],
    [
      ["--agent", "codex", "--claude-permission-mode", "plan", "go"],
      {},
      "--claude-permission-mode is incompatible with Codex. Remove --claude-permission-mode.",
    ],
    [
      ["--agent", "claude", "go"],
      { ELWOOD_CODEX_SANDBOX: "read-only" },
      "ELWOOD_CODEX_SANDBOX is incompatible with Claude. Use --no-defaults to ignore ELWOOD_CODEX_SANDBOX.",
    ],
    [
      ["--agent", "claude", "go"],
      { ELWOOD_CODEX_APPROVAL_POLICY: "on-request" },
      "ELWOOD_CODEX_APPROVAL_POLICY is incompatible with Claude. Use --no-defaults to ignore ELWOOD_CODEX_APPROVAL_POLICY.",
    ],
    [
      ["--agent", "codex", "go"],
      { ELWOOD_CLAUDE_PERMISSION_MODE: "plan" },
      "ELWOOD_CLAUDE_PERMISSION_MODE is incompatible with Codex. Use --no-defaults to ignore ELWOOD_CLAUDE_PERMISSION_MODE.",
    ],
  ])("C-CLI-20 identifies adapter-option source %#", async (argv, env, message) => {
    const cwd = root();
    await expect(resolveRunRequest(run(argv), context(cwd, env))).rejects.toThrow(message);
  });

  test("C-CLI-20 explains flag and inherited recovery when both conflict", async () => {
    const cwd = root();
    await expect(
      resolveRunRequest(
        run(["--agent", "claude", "--codex-sandbox", "read-only", "go"]),
        context(cwd, { ELWOOD_CODEX_APPROVAL_POLICY: "on-request" }),
      ),
    ).rejects.toThrow(
      "--codex-sandbox and ELWOOD_CODEX_APPROVAL_POLICY are incompatible with Claude. Remove --codex-sandbox. Use --no-defaults to ignore ELWOOD_CODEX_APPROVAL_POLICY.",
    );
  });

  test.each([
    [
      ["--resume", "s", "--persona", "p"],
      {},
      "--persona is incompatible with --resume. Remove --persona.",
    ],
    [
      ["--resume", "s"],
      { ELWOOD_PERSONA: "p" },
      "ELWOOD_PERSONA is incompatible with --resume. Use --no-defaults to ignore ELWOOD_PERSONA.",
    ],
  ])("C-CLI-20 identifies resume-persona source %#", (argv, env, message) => {
    const cwd = root();
    expect(() => resolveRunSettings(run(argv), context(cwd, env))).toThrow(message);
  });

  test.each([
    [
      ["--resume", "s", "--codex-sandbox", "read-only"],
      {},
      "claude",
      "--codex-sandbox is incompatible with Claude. Remove --codex-sandbox.",
    ],
    [
      ["--resume", "s"],
      { ELWOOD_CODEX_APPROVAL_POLICY: "on-request" },
      "claude",
      "ELWOOD_CODEX_APPROVAL_POLICY is incompatible with Claude. Use --no-defaults to ignore ELWOOD_CODEX_APPROVAL_POLICY.",
    ],
    [
      ["--resume", "s", "--claude-permission-mode", "plan"],
      {},
      "codex",
      "--claude-permission-mode is incompatible with Codex. Remove --claude-permission-mode.",
    ],
    [
      ["--resume", "s"],
      { ELWOOD_CLAUDE_PERMISSION_MODE: "plan" },
      "codex",
      "ELWOOD_CLAUDE_PERMISSION_MODE is incompatible with Codex. Use --no-defaults to ignore ELWOOD_CLAUDE_PERMISSION_MODE.",
    ],
  ] as const)("C-CLI-20 identifies resumed adapter-option source %#", async (argv, env, agent, message) => {
    const cwd = root();
    const draft = resolveRunSettings(run(argv), context(cwd, env));
    await expect(finalizeRunRequest(draft, { agent, cwd })).rejects.toThrow(message);
  });

  test.each([
    [
      ["--resume", "s", "--agent", "codex"],
      {},
      "claude",
      "--agent is incompatible with the stored Claude session. Remove --agent.",
    ],
    [
      ["--resume", "s"],
      { ELWOOD_AGENT: "codex" },
      "claude",
      "ELWOOD_AGENT is incompatible with the stored Claude session. Use --no-defaults to ignore ELWOOD_AGENT.",
    ],
    [
      ["--resume", "s", "--agent", "claude"],
      {},
      "codex",
      "--agent is incompatible with the stored Codex session. Remove --agent.",
    ],
  ] as const)("C-CLI-20 identifies resumed adapter source %#", async (argv, env, storedAgent, message) => {
    const cwd = root();
    const draft = resolveRunSettings(run(argv), context(cwd, env));
    await expect(finalizeRunRequest(draft, { agent: storedAgent, cwd })).rejects.toThrow(message);
  });

  test("C-CLI-06 keeps inactive saved per-agent blocks valid", async () => {
    const cwd = root();
    const config = join(cwd, "config.json");
    writeFileSync(
      config,
      JSON.stringify({
        schemaVersion: 1,
        agent: "codex",
        claude: { permissionMode: "plan" },
        codex: { sandbox: "read-only", approvalPolicy: "on-request" },
      }),
      { mode: 0o600 },
    );
    await expect(
      resolveRunRequest(run(["go"]), context(cwd, { ELWOOD_CONFIG: config })),
    ).resolves.toMatchObject({ agent: "codex", sandbox: "read-only" });
    await expect(
      resolveRunRequest(run(["--agent", "claude", "go"]), context(cwd, { ELWOOD_CONFIG: config })),
    ).resolves.toMatchObject({ agent: "claude", permissionMode: "plan" });
  });
});
