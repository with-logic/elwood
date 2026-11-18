/**
 * Conformance tests for the Claude try-resume-else-start entry point.
 * Covers PRD §5.2 and C-API-26.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { type ClaudeHookEventFor, startOrResumeClaude } from "../../src/index.ts";
import {
  createSessionRecord,
  prepareStateDir,
  readSessionRecord,
  sessionDir,
  writeSessionRecord,
} from "../../src/state/store.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("startOrResumeClaude", () => {
  test("C-API-26 starts fresh when no elwoodSessionId is provided", async () => {
    const cwd = tempDir();
    installFakes();
    const result = await startOrResumeClaude({ cwd });
    expect(result.resumed).toBe(false);
    expect(result.session.status).toBe("running");
  });

  test("C-API-26 resumes when the record has a resume id", async () => {
    const cwd = tempDir();
    installFakes();
    const first = await startOrResumeClaude({ cwd });
    const record = createSessionRecord({ cwd, id: "resumable" });
    writeSessionRecord(
      { ...record, claude: { resumeId: "claude-native" } },
      sessionDir(join(cwd, ".elwood"), "resumable"),
    );
    const result = await startOrResumeClaude({
      cwd,
      elwoodSessionId: "resumable",
      stateDir: join(cwd, ".elwood"),
      hooks: {},
      initialSize: { cols: 90, rows: 30 },
      autoupdate: false,
      autotrust: false,
      hookTimeoutMs: 5_000,
      reasoningEffort: "high",
      permissionMode: "bypassPermissions",
      allowedTools: ["Read"],
      disallowedTools: ["Bash"],
      tools: ["Read", "Edit"],
      strictVersionCheck: false,
    });
    expect(result.resumed).toBe(true);
    expect(result.session.elwoodSessionId).toBe("resumable");
    // C-API-29 privilege options survive the startOrResume resume path.
    expect(ptys.at(-1)!.options.args.join(" ")).toContain("--permission-mode 'bypassPermissions'");
    expect(ptys.at(-1)!.options.args.join(" ")).toContain("--allowedTools 'Read'");
    expect(ptys.at(-1)!.options.args.join(" ")).toContain("--disallowedTools 'Bash'");
    expect(ptys.at(-1)!.options.args.join(" ")).toContain("--tools 'Read,Edit'");
    // C-CLAUDE-20: reasoningEffort is not persisted, so the resume path must forward it.
    expect(ptys.at(-1)!.options.args.join(" ")).toContain("--effort 'high'");
    await first.session.stop();
    await result.session.stop();
  });

  test("C-API-26 falls back to start on the no-resumable-session error names", async () => {
    const cwd = tempDir();
    installFakes();
    // state_not_found: no record for this id.
    const missing = await startOrResumeClaude({ cwd, elwoodSessionId: "never-persisted" });
    expect(missing.resumed).toBe(false);
    // resume_unavailable: record exists but no Claude resume id was learned.
    const record = createSessionRecord({ cwd, id: "no-id" });
    writeSessionRecord(record, sessionDir(join(cwd, ".elwood"), "no-id"));
    const unavailable = await startOrResumeClaude({ cwd, elwoodSessionId: "no-id" });
    expect(unavailable.resumed).toBe(false);
    // adapter_mismatch: the record belongs to Codex.
    const codexRecord = createSessionRecord({ cwd, id: "codex-owned", adapter: "codex" });
    writeSessionRecord(
      { ...codexRecord, codex: { resumeId: "codex-native" } },
      sessionDir(join(cwd, ".elwood"), "codex-owned"),
    );
    const mismatch = await startOrResumeClaude({ cwd, elwoodSessionId: "codex-owned" });
    expect(mismatch.resumed).toBe(false);
  });

  test("C-API-26 rethrows real failures such as corrupt state", async () => {
    const cwd = tempDir();
    installFakes();
    const stateDir = join(cwd, ".elwood");
    mkdirSync(join(stateDir, "sessions", "broken"), { recursive: true });
    writeFileSync(join(stateDir, "sessions", "broken", "session.json"), "{");
    await expect(startOrResumeClaude({ cwd, elwoodSessionId: "broken" })).rejects.toMatchObject({
      code: "state_corrupt",
    });
  });

  test("C-API-26 C-CLAUDE-08 restarts a ready startup-only session fresh", async () => {
    const cwd = tempDir();
    installFakes();
    const options = { cwd, stateDir: join(cwd, "state"), autotrust: true, highTrust: true };
    const first = await startOrResumeClaude(options);
    const elwoodSessionId = first.session.elwoodSessionId;
    const hook = { session_id: "native-empty", cwd };
    await ptys[0]!.dispatchHook(
      elwoodSessionId,
      { ...hook, hook_event_name: "SessionStart", source: "startup" },
      options.stateDir,
    );
    await ptys[0]!.dispatchHook(
      elwoodSessionId,
      {
        ...hook,
        hook_event_name: "InstructionsLoaded",
        file_path: join(cwd, "CLAUDE.md"),
        memory_type: "Project",
        load_reason: "session_start",
      },
      options.stateDir,
    );
    expect(first.session.status).toBe("ready");
    await first.session.stop();
    const second = await startOrResumeClaude({ ...options, elwoodSessionId });
    expect(second.resumed).toBe(false);
    expect(second.session.elwoodSessionId).not.toBe(elwoodSessionId);
    expect(ptys).toHaveLength(2);
    expect(ptys[1]!.options.args.join(" ")).not.toContain("--resume");
    await second.session.stop();
  });

  test("C-CLAUDE-08 only an unblocked user submission establishes a resume id", async () => {
    const cwd = tempDir();
    installFakes();
    let block = true;
    const options = {
      cwd,
      stateDir: join(cwd, "state"),
      hooks: {
        UserPromptSubmit: () =>
          block ? { decision: "block" as const, reason: "Try later" } : undefined,
      },
    };
    const first = await startOrResumeClaude(options);
    const elwoodSessionId = first.session.elwoodSessionId;
    const hook = {
      hook_event_name: "UserPromptSubmit",
      session_id: "native-user",
      cwd,
      prompt: "hello",
    } satisfies ClaudeHookEventFor<"UserPromptSubmit">;
    await ptys[0]!.dispatchHook(
      elwoodSessionId,
      { hook_event_name: "SessionStart", session_id: "native-user", cwd, source: "startup" },
      options.stateDir,
    );
    await ptys[0]!.dispatchHook(elwoodSessionId, hook, options.stateDir);
    expect(readSessionRecord(options.stateDir, elwoodSessionId).claude.resumeId).toBeUndefined();
    block = false;
    await ptys[0]!.dispatchHook(elwoodSessionId, hook, options.stateDir);
    expect(readSessionRecord(options.stateDir, elwoodSessionId).claude.resumeId).toBe(
      "native-user",
    );
    await first.session.stop();
    const second = await startOrResumeClaude({ ...options, elwoodSessionId });
    expect(second.resumed).toBe(true);
    expect(second.session.elwoodSessionId).toBe(elwoodSessionId);
    await second.session.stop();
  });
});

test("C-API-26 highTrust expands and rejects conflicting posture on resume and fallback", async () => {
  const cwd = tempDir();
  installFakes();
  const stateDir = join(cwd, ".elwood");
  prepareStateDir(stateDir, { cwd, isImplicitDefaultStateDir: true });
  const record = createSessionRecord({ cwd, id: "high", adapter: "claude" });
  writeSessionRecord(
    { ...record, claude: { resumeId: "native", launch: { permissionMode: "plan" } } },
    sessionDir(stateDir, "high"),
  );
  for (const elwoodSessionId of ["high", "absent"]) {
    const result = await startOrResumeClaude({ cwd, elwoodSessionId, highTrust: true });
    expect(result.resumed).toBe(elwoodSessionId === "high");
    expect(ptys.at(-1)!.options.args.join(" ")).toContain("--permission-mode 'bypassPermissions'");
    await result.session.stop();
    await expect(
      startOrResumeClaude({ cwd, elwoodSessionId, highTrust: true, permissionMode: "plan" }),
    ).rejects.toMatchObject({ code: "claude_high_trust_conflict" });
  }
});
