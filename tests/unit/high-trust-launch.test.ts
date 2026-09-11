/**
 * Library-side `highTrust` at launch: the expanded posture reaches the spawned
 * command and the persisted record on start and resume, and a conflicting explicit
 * posture is rejected before any spawn. Covers PRD §5.1/§5.2/§5.5/§5.6 (C-API-54).
 */

import { realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resumeClaude, resumeCodex, startClaude, startCodex } from "../../src/index.ts";
import { safeSessionDir } from "../../src/state/files.ts";
import {
  createSessionRecord,
  prepareStateDir,
  readSessionRecord,
  updateSessionResumeId,
  writeSessionRecord,
} from "../../src/state/store.ts";
import * as claudeFakes from "../claude/helpers.ts";
import * as codexFakes from "../codex/helpers.ts";

describe("highTrust launch (Claude)", () => {
  afterEach(claudeFakes.resetFakes);

  test("C-API-54 startClaude launches and persists bypassPermissions", async () => {
    const cwd = claudeFakes.tempDir();
    const stateDir = join(cwd, ".elwood");
    claudeFakes.installFakes();
    const session = await startClaude({ cwd, stateDir, highTrust: true });
    try {
      const command = claudeFakes.ptys[0]!.options.args.join(" ");
      expect(command).toContain("--permission-mode 'bypassPermissions'");
      expect(command).not.toContain("highTrust");
      const record = readSessionRecord(stateDir, session.elwoodSessionId);
      expect(record.adapter === "claude" && record.claude.launch).toEqual({
        permissionMode: "bypassPermissions",
      });
    } finally {
      await session.teardown();
    }
  });

  test("C-API-54 startClaude rejects the conflict before any spawn", async () => {
    const cwd = claudeFakes.tempDir();
    claudeFakes.installFakes();
    await expect(startClaude({ cwd, highTrust: true, permissionMode: "dontAsk" })).rejects.toThrow(
      expect.objectContaining({ code: "claude_high_trust_conflict" }),
    );
    expect(claudeFakes.ptys).toHaveLength(0);
  });

  test("C-API-54 resumeClaude expands highTrust into the relaunched posture", async () => {
    const cwd = claudeFakes.tempDir();
    const stateDir = join(cwd, ".elwood");
    prepareStateDir(stateDir);
    const record = updateSessionResumeId(
      createSessionRecord({ cwd, id: "resume-high-trust" }),
      "claude",
      "claude-resume",
    );
    writeSessionRecord(
      { ...record, claude: { ...record.claude, launch: { permissionMode: "plan" } } },
      safeSessionDir(stateDir, record.elwoodSessionId),
    );
    claudeFakes.installFakes();
    await expect(
      resumeClaude({
        cwd,
        stateDir,
        elwoodSessionId: "resume-high-trust",
        highTrust: true,
        tools: [],
      }),
    ).resolves.toBeDefined();
    expect(claudeFakes.ptys[0]!.options.args.join(" ")).toContain(
      "--permission-mode 'bypassPermissions'",
    );
    await expect(
      resumeClaude({
        cwd,
        stateDir,
        elwoodSessionId: "x",
        highTrust: true,
        permissionMode: "plan",
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "claude_high_trust_conflict" }));
  });
});

describe("highTrust launch (Codex)", () => {
  afterEach(codexFakes.resetFakes);

  test("C-API-54 startCodex launches and persists danger-full-access + never", async () => {
    const cwd = realpathSync(codexFakes.tempDir());
    const stateDir = join(cwd, ".elwood");
    codexFakes.installFakes();
    const session = await startCodex({ cwd, stateDir, highTrust: true });
    try {
      const command = codexFakes.ptys[0]!.options.args.join(" ");
      expect(command).toContain("--sandbox 'danger-full-access'");
      expect(command).toContain("--ask-for-approval 'never'");
      const record = readSessionRecord(stateDir, session.elwoodSessionId);
      expect(record.adapter === "codex" && record.codex.launch).toEqual({
        sandbox: "danger-full-access",
        approvalPolicy: "never",
      });
    } finally {
      await session.teardown();
    }
  });

  test("C-API-54 startCodex and resumeCodex reject the conflict before any spawn", async () => {
    const cwd = realpathSync(codexFakes.tempDir());
    codexFakes.installFakes();
    await expect(startCodex({ cwd, highTrust: true, sandbox: "workspace-write" })).rejects.toThrow(
      expect.objectContaining({ code: "codex_high_trust_conflict" }),
    );
    await expect(
      resumeCodex({ cwd, elwoodSessionId: "x", highTrust: true, approvalPolicy: "never" }),
    ).rejects.toThrow(expect.objectContaining({ code: "codex_high_trust_conflict" }));
    expect(codexFakes.ptys).toHaveLength(0);
  });

  test("C-API-54 resumeCodex expands highTrust into the relaunched posture", async () => {
    const cwd = realpathSync(codexFakes.tempDir());
    const stateDir = join(cwd, ".elwood");
    prepareStateDir(stateDir);
    const record = createSessionRecord({ cwd, id: "codex-high-trust", adapter: "codex" });
    writeSessionRecord(
      { ...record, codex: { resumeId: "codex-session-1", launch: { sandbox: "read-only" } } },
      safeSessionDir(stateDir, "codex-high-trust"),
    );
    codexFakes.installFakes();
    await resumeCodex({ cwd, stateDir, elwoodSessionId: "codex-high-trust", highTrust: true });
    const command = codexFakes.ptys[0]!.options.args.join(" ");
    expect(command).toContain("--sandbox 'danger-full-access'");
    expect(command).toContain("--ask-for-approval 'never'");
  });
});
