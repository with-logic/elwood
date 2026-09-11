/**
 * `--high-trust` conflicts, argument diagnostics, resume override, the config key,
 * and `config effective` provenance. Covers PRD §12A.2/§12A.4 (C-CLI-13, C-CLI-19,
 * C-CLI-20, C-CLI-22).
 */

import { describe, expect, test } from "vitest";
import { parseCliArgs } from "../../src/cli/args/index.ts";
import { parseConfigText, parseConfigValue, setConfigValue } from "../../src/cli/config/codec.ts";
import { writeEffectiveConfig } from "../../src/cli/config/effective.ts";
import { finalizeRunRequest, resolveRunSettings } from "../../src/cli/request/index.ts";
import { AsyncOutputSink } from "../../src/cli/stream.ts";
import { detectClaude as detect } from "./agent-fakes.ts";
import { context, root, run } from "./high-trust-helpers.ts";
import { MemoryWriter } from "./run-fakes.ts";

describe("--high-trust conflicts and reporting", () => {
  test.each([
    [
      ["--agent", "claude", "--high-trust", "--claude-permission-mode", "plan", "go"],
      {},
      "--claude-permission-mode is incompatible with --high-trust. Remove --claude-permission-mode.",
    ],
    [
      ["--high-trust", "go"],
      { ELWOOD_CODEX_SANDBOX: "read-only" },
      "ELWOOD_CODEX_SANDBOX is incompatible with --high-trust. Use --no-defaults to ignore ELWOOD_CODEX_SANDBOX.",
    ],
    [
      ["--codex-approval-policy", "on-request", "go"],
      { ELWOOD_HIGH_TRUST: "true" },
      "--codex-approval-policy is incompatible with ELWOOD_HIGH_TRUST. Remove --codex-approval-policy.",
    ],
    [
      ["--agent", "claude", "go"],
      { ELWOOD_HIGH_TRUST: "true", ELWOOD_CLAUDE_PERMISSION_MODE: "plan" },
      "ELWOOD_CLAUDE_PERMISSION_MODE is incompatible with ELWOOD_HIGH_TRUST. Use --no-defaults to ignore ELWOOD_CLAUDE_PERMISSION_MODE.",
    ],
    [
      ["--resume", "s", "--high-trust", "--codex-sandbox", "read-only"],
      {},
      "--codex-sandbox is incompatible with --high-trust. Remove --codex-sandbox.",
    ],
  ])("C-CLI-22 rejects explicit posture alongside high trust %#", async (argv, env, message) => {
    const cwd = root();
    await expect(resolveRunSettings(run(argv), context(cwd, env), detect)).rejects.toThrow(message);
  });

  test("C-CLI-20 the flag pair and near-miss spellings are diagnosed", () => {
    expect(() => parseCliArgs(["--high-trust", "--no-high-trust", "go"])).toThrow(
      "--high-trust and --no-high-trust cannot be combined.",
    );
    expect(() => parseCliArgs(["--high-trus", "go"])).toThrow(
      "Unknown option '--high-trus'. Did you mean '--high-trust'?",
    );
  });

  test("C-CLI-22 on resume the flag overrides the stored adapter's posture", async () => {
    const cwd = root();
    const draft = await resolveRunSettings(
      run(["--resume", "s", "--high-trust"]),
      context(cwd),
      detect,
    );
    const claude = await finalizeRunRequest(draft, { agent: "claude", cwd });
    expect(claude).toMatchObject({ permissionMode: "bypassPermissions" });
    expect(claude.resolution?.sources).toMatchObject({
      permissionMode: "--high-trust",
      sandbox: "not applicable",
    });
    const codex = await finalizeRunRequest(draft, { agent: "codex", cwd });
    expect(codex).toMatchObject({ sandbox: "danger-full-access", approvalPolicy: "never" });
    expect(codex.resolution?.sources.permissionMode).toBe("not applicable");
  });

  test("C-CLI-13 the highTrust config key is a strict boolean", () => {
    expect(parseConfigValue("highTrust", "true")).toBe(true);
    expect(parseConfigValue("highTrust", "false")).toBe(false);
    expect(() => parseConfigValue("highTrust", "yes")).toThrow(/true or false/u);
    expect(setConfigValue({ schemaVersion: 1 }, "highTrust", "true")).toEqual({
      schemaVersion: 1,
      highTrust: true,
    });
    expect(() => parseConfigText('{"schemaVersion":1,"highTrust":"x"}')).toThrow(
      "highTrust must be true or false.",
    );
  });

  test("C-CLI-19 config effective reports highTrust and the posture it decided", async () => {
    const cwd = root();
    const writer = new MemoryWriter();
    const stdout = new AsyncOutputSink(writer);
    await writeEffectiveConfig(["--agent", "claude", "--high-trust"], {
      ...context(cwd),
      stdout,
    });
    expect(JSON.parse(writer.value).settings).toMatchObject({
      highTrust: { value: true, source: "--high-trust" },
      permissionMode: { value: "bypassPermissions", source: "--high-trust" },
      sandbox: { value: null, source: "not applicable" },
    });
    // Without the switch the posture is the ordinary built-in one for the
    // selected agent (here Codex, named so the assertion does not depend on
    // which agent this machine auto-detects).
    const plain = new MemoryWriter();
    await writeEffectiveConfig(["--agent", "codex"], {
      ...context(cwd),
      stdout: new AsyncOutputSink(plain),
    });
    expect(JSON.parse(plain.value).settings).toMatchObject({
      highTrust: { value: false, source: "built-in" },
      sandbox: { value: "workspace-write", source: "built-in" },
    });
  });
});
