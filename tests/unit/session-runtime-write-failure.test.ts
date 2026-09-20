/** Failed per-launch runtime writes preserve socket ownership boundaries (PRD §8.1/§9.1). */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { resumeClaude, resumeCodex, startClaude, startCodex } from "../../src/index.ts";
import {
  resetSocketHomeRootForTests,
  setSocketHomeRootForTests,
} from "../../src/state/socket-home.ts";
import * as claude from "../claude/helpers.ts";
import * as codex from "../codex/helpers.ts";
import { socketFilesIn } from "../helpers/socket-leak.ts";

const fault = vi.hoisted(() => ({ enabled: false, hit: false }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    renameSync: (from: string, to: string) => {
      if (fault.enabled && /\/hook-bridge-[^/]+\.mjs$/.test(to)) {
        fault.hit = true;
        mkdirSync(join(to, "block"), { recursive: true });
      }
      fs.renameSync(from, to);
    },
  };
});

afterEach(() => {
  fault.enabled = false;
  fault.hit = false;
  resetSocketHomeRootForTests();
  claude.resetFakes();
  codex.resetFakes();
});

for (const adapter of [
  { name: "claude", start: startClaude, resume: resumeClaude, helpers: claude },
  { name: "codex", start: startCodex, resume: resumeCodex, helpers: codex },
] as const) {
  test(`C-API-20 ${adapter.name} runtime rename failure removes only the failed launch socket`, async () => {
    adapter.helpers.installFakes();
    const cwd = adapter.helpers.tempDir();
    const root = mkdtempSync("/tmp/elwood-write-failure-");
    setSocketHomeRootForTests(root);
    const prior = await adapter.start({ cwd });
    try {
      await adapter.helpers.ptys[0]!.dispatchHook(prior.elwoodSessionId, {
        hook_event_name: "SessionStart",
        session_id: "prior",
        cwd,
        source: "startup",
      });
      const before = socketFilesIn(root);
      expect(before).toHaveLength(1);
      fault.enabled = true;
      await expect(
        adapter.resume({ cwd, elwoodSessionId: prior.elwoodSessionId }),
      ).rejects.toThrow();
      expect(fault.hit).toBe(true);
      expect(socketFilesIn(root)).toEqual(before);
    } finally {
      fault.enabled = false;
      await prior.teardown();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
