/** Effective request validation branches. Covers PRD C-CLI-03/C-CLI-06/C-CLI-14. */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseCliArgs } from "../../src/cli/args.ts";
import { resolveRunRequest } from "../../src/cli/request.ts";
import type { ParsedRunCommand, RequestContext } from "../../src/cli/types.ts";

async function* emptyStdin(...values: readonly string[]) {
  await Promise.resolve();
  for (const value of values) yield value;
}
function sandbox(): string {
  return mkdtempSync(join(tmpdir(), "elwood-request-edge-"));
}
function context(
  root: string,
  env: Readonly<Record<string, string | undefined>> = {},
): RequestContext {
  return { env, homeDir: root, invocationCwd: root, stdin: { isTTY: true, source: emptyStdin() } };
}
function run(argv: readonly string[]): ParsedRunCommand {
  const parsed = parseCliArgs(argv);
  if (parsed.command !== "run") throw new Error("expected run");
  return parsed;
}
describe("effective request edges", () => {
  test("resolves all Codex flags and defaults", async () => {
    const root = sandbox();
    await expect(
      resolveRunRequest(
        run([
          "--output",
          "text",
          "--timeout",
          "1s",
          "--no-trust",
          "--state-dir",
          "s",
          "--verbose",
          "--model",
          "m",
          "--reasoning-effort",
          "minimal",
          "--codex-sandbox",
          "read-only",
          "--codex-approval-policy",
          "on-request",
          "--persona",
          "p",
          "--keep",
          "go",
        ]),
        context(root),
      ),
    ).resolves.toMatchObject({
      agent: "codex",
      outputExplicit: true,
      timeoutMs: 1_000,
      trust: false,
      stateDir: join(root, "s"),
      verbose: true,
      model: "m",
      reasoningEffort: "minimal",
      sandbox: "read-only",
      approvalPolicy: "on-request",
      persona: "p",
      keep: true,
      cwd: root,
    });
  });

  test("resolves Claude config and environment precedence", async () => {
    const root = sandbox();
    const path = join(root, "config.json");
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        agent: "claude",
        output: "text",
        timeout: "2s",
        stateDir: "cfg",
        verbose: true,
        stream: false,
        persona: "config persona",
        claude: { model: "config-model", reasoningEffort: "low", permissionMode: "auto" },
        codex: { sandbox: "read-only", approvalPolicy: "on-request" },
      }),
      { mode: 0o600 },
    );
    await expect(
      resolveRunRequest(
        run(["go"]),
        context(root, {
          ELWOOD_CONFIG: path,
          ELWOOD_MODEL: "env-model",
          ELWOOD_REASONING_EFFORT: "high",
          ELWOOD_CLAUDE_PERMISSION_MODE: "plan",
        }),
      ),
    ).resolves.toMatchObject({
      agent: "claude",
      output: "text",
      timeoutMs: 2_000,
      stateDir: join(root, "cfg"),
      verbose: true,
      persona: "config persona",
      model: "env-model",
      reasoningEffort: "high",
      permissionMode: "plan",
    });
  });

  test("applies Claude's default non-interactive permission mode", async () => {
    await expect(
      resolveRunRequest(run(["--agent", "claude", "go"]), context(sandbox())),
    ).resolves.toMatchObject({ permissionMode: "dontAsk" });
  });

  test.each([
    [["--keep", "--ephemeral", "go"], /cannot be combined/iu],
    [["--ephemeral", "go"], /requires --resume/iu],
    [["--keep", "--resume", "s", "go"], /only valid/iu],
    [["--resume", "s", "--persona", "p", "go"], /persona/iu],
    [["--agent", "claude", "--codex-sandbox", "read-only", "go"], /Codex launch/iu],
    [["--agent", "claude", "--codex-approval-policy", "never", "go"], /Codex launch/iu],
    [["--agent", "codex", "--claude-permission-mode", "plan", "go"], /Claude permission/iu],
    [["--agent", "bad", "go"], /agent must be one/iu],
    [["--output", "bad", "go"], /output must be one/iu],
    [["--reasoning-effort", "minimal", "--agent", "claude", "go"], /reasoningEffort/iu],
    [["--state-dir", " ", "go"], /stateDir/iu],
    [["--model", " ", "go"], /model/iu],
    [["--resume", " ", "go"], /resume/iu],
  ])("rejects incompatible invocation %#", async (argv, message) => {
    await expect(resolveRunRequest(run(argv), context(sandbox()))).rejects.toThrow(message);
  });

  test("rejects agent-specific environment for the selected adapter", async () => {
    const root = sandbox();
    await expect(
      resolveRunRequest(
        run(["go"]),
        context(root, {
          ELWOOD_AGENT: "claude",
          ELWOOD_CODEX_SANDBOX: "read-only",
        }),
      ),
    ).rejects.toThrow(/Codex launch/iu);
    await expect(
      resolveRunRequest(
        run(["go"]),
        context(root, {
          ELWOOD_AGENT: "codex",
          ELWOOD_CLAUDE_PERMISSION_MODE: "plan",
        }),
      ),
    ).rejects.toThrow(/Claude permission/iu);
  });
});
