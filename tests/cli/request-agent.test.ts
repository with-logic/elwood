/**
 * Agent selection within effective request resolution: explicit choices are
 * never probed, an unselected new session is (PRD §12A.1/§12A.4, C-CLI-21).
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseCliArgs } from "../../src/cli/args/index.ts";
import { autoDetectedSource } from "../../src/cli/request/agent-detect.ts";
import { resolveRunRequest } from "../../src/cli/request/index.ts";
import { detectClaude, detectCodex, detectNothing } from "./agent-fakes.ts";

async function* stdin(value = "") {
  await Promise.resolve();
  if (value !== "") yield value;
}

describe("effective request agent selection", () => {
  test("C-CLI-21 a selected agent is never probed; an unselected new session is", async () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-cli-request-"));
    const context = {
      env: {},
      homeDir: root,
      invocationCwd: root,
      stdin: { isTTY: true, source: stdin() },
    } as const;
    const chosen = parseCliArgs(["--agent", "codex", "go"]);
    const open = parseCliArgs(["go"]);
    if (chosen.command !== "run" || open.command !== "run") throw new Error("expected run");
    await expect(resolveRunRequest(chosen, context, detectNothing)).resolves.toMatchObject({
      agent: "codex",
      resolution: { sources: { agent: "--agent" } },
    });
    await expect(resolveRunRequest(open, context, detectClaude)).resolves.toMatchObject({
      agent: "claude",
      permissionMode: "dontAsk",
      resolution: { sources: { agent: autoDetectedSource } },
    });
    expect("explicitAgent" in (await resolveRunRequest(open, context, detectClaude))).toBe(false);
    await expect(resolveRunRequest(open, context, detectNothing)).rejects.toMatchObject({
      name: "CliValidationError",
      code: "no_agent_found",
    });
  });

  test("C-CLI-21 a config-selected agent is never probed", async () => {
    const root = mkdtempSync(join(tmpdir(), "elwood-cli-request-"));
    const parsed = parseCliArgs(["go"]);
    if (parsed.command !== "run") throw new Error("expected run");
    await expect(
      resolveRunRequest(
        parsed,
        {
          env: { ELWOOD_AGENT: "codex" },
          homeDir: root,
          invocationCwd: root,
          stdin: { isTTY: true, source: stdin() },
        },
        detectNothing,
      ),
    ).resolves.toMatchObject({
      agent: "codex",
      explicitAgent: "codex",
      resolution: { sources: { agent: "ELWOOD_AGENT" } },
    });
  });

  test.each([
    [
      ["--codex-sandbox", "read-only", "go"],
      {},
      detectClaude,
      "--codex-sandbox is incompatible with the auto-detected Claude agent. Remove --codex-sandbox, or select --agent codex.",
    ],
    [
      ["go"],
      { ELWOOD_CLAUDE_PERMISSION_MODE: "plan" },
      detectCodex,
      "ELWOOD_CLAUDE_PERMISSION_MODE is incompatible with the auto-detected Codex agent. Use --no-defaults to ignore ELWOOD_CLAUDE_PERMISSION_MODE, or select --agent claude.",
    ],
    [
      ["--codex-approval-policy", "never", "go"],
      { ELWOOD_CODEX_SANDBOX: "read-only" },
      detectClaude,
      "--codex-approval-policy and ELWOOD_CODEX_SANDBOX are incompatible with the auto-detected Claude agent. Remove --codex-approval-policy. Use --no-defaults to ignore ELWOOD_CODEX_SANDBOX, or select --agent codex.",
    ],
  ])("C-CLI-20/C-CLI-21 names auto-detection and offers the other agent %#", async (argv, env, detect, message) => {
    const root = mkdtempSync(join(tmpdir(), "elwood-cli-request-"));
    const parsed = parseCliArgs(argv);
    if (parsed.command !== "run") throw new Error("expected run");
    await expect(
      resolveRunRequest(
        parsed,
        { env, homeDir: root, invocationCwd: root, stdin: { isTTY: true, source: stdin() } },
        detect,
      ),
    ).rejects.toThrow(message);
  });
});
