/**
 * Conformance tests for the Codex try-resume-else-start entry point.
 * Covers PRD §5.6 and C-API-26.
 */

import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { startOrResumeCodex } from "../../src/index.ts";
import { safeSessionDir } from "../../src/state/files.ts";
import { createSessionRecord, prepareStateDir, writeSessionRecord } from "../../src/state/store.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("startOrResumeCodex", () => {
  test("C-API-26 resumes with a resume id and falls back without one", async () => {
    const cwd = tempDir();
    installFakes();
    const stateDir = join(cwd, ".elwood");
    prepareStateDir(stateDir);
    const record = createSessionRecord({ cwd, id: "resumable", adapter: "codex" });
    writeSessionRecord(
      { ...record, codex: { resumeId: "codex-native" } },
      safeSessionDir(stateDir, "resumable"),
    );
    const resumed = await startOrResumeCodex({
      cwd,
      elwoodSessionId: "resumable",
      stateDir: join(cwd, ".elwood"),
      hooks: {},
      initialSize: { cols: 90, rows: 30 },
      autoupdate: false,
      autotrust: false,
      hookTimeoutMs: 5_000,
      reasoningEffort: "high",
      sandbox: "read-only",
      approvalPolicy: "never",
      strictVersionCheck: false,
    });
    expect(resumed.resumed).toBe(true);
    // C-API-29 privilege options survive the startOrResume resume path.
    expect(ptys.at(-1)!.options.args.join(" ")).toContain("--sandbox 'read-only'");
    expect(ptys.at(-1)!.options.args.join(" ")).toContain("--ask-for-approval 'never'");
    // C-CODEX-21 a resume must re-supply reasoningEffort: startOrResume forwards it.
    expect(ptys.at(-1)!.options.args.join(" ")).toContain('model_reasoning_effort="high"');
    expect(ptys.at(-1)!.options.args.join(" ")).toContain("timeout=10}"); // 5 s + 5 s slack
    expect(resumed.session.elwoodSessionId).toBe("resumable");
    const fresh = await startOrResumeCodex({ cwd, elwoodSessionId: "missing" });
    expect(fresh.resumed).toBe(false);
    await resumed.session.stop();
    await fresh.session.stop();
  });
});
