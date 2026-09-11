/**
 * Conformance tests for the Claude try-resume-else-start entry point.
 * Covers PRD §5.2 and C-API-26.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { startOrResumeClaude } from "../../src/index.ts";
import { createSessionRecord, sessionDir, writeSessionRecord } from "../../src/state/store.ts";
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
});
