/**
 * Conformance tests for the Codex try-resume-else-start entry point.
 * Covers PRD §5.6 and C-API-26.
 */

import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { startOrResumeCodex } from "../../src/index.ts";
import { createSessionRecord, writeSessionRecord } from "../../src/state/store.ts";
import { installFakes, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

describe("startOrResumeCodex", () => {
  test("C-API-26 resumes with a resume id and falls back without one", async () => {
    const cwd = tempDir();
    installFakes();
    const record = createSessionRecord({
      stateDir: join(cwd, ".elwood"),
      cwd,
      id: "resumable",
      adapter: "codex",
    });
    writeSessionRecord({ ...record, codex: { resumeId: "codex-native" } });
    const resumed = await startOrResumeCodex({
      cwd,
      elwoodSessionId: "resumable",
      stateDir: join(cwd, ".elwood"),
      hooks: {},
      initialSize: { cols: 90, rows: 30 },
      autoupdate: false,
      autotrust: false,
      hookTimeoutMs: 5_000,
      strictVersionCheck: false,
    });
    expect(resumed.resumed).toBe(true);
    expect(resumed.session.elwoodSessionId).toBe("resumable");
    const fresh = await startOrResumeCodex({ cwd, elwoodSessionId: "missing" });
    expect(fresh.resumed).toBe(false);
    await resumed.session.stop();
    await fresh.session.stop();
  });
});
