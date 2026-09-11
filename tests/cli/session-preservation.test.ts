/**
 * Persisted-resume identity coverage for kept headless CLI sessions.
 * Covers PRD §12A.2-§12A.3 and C-CLI-08/C-CLI-11/C-CLI-15.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { HeadlessCliSession } from "../../src/cli/session/index.ts";
import type { CliAgent } from "../../src/cli/types.ts";
import type { ElwoodAgentSession } from "../../src/core/agent-session.ts";
import {
  createSessionRecord,
  prepareStateDir,
  sessionDir,
  writeSessionRecord,
} from "../../src/state/store.ts";
import { effectiveRequest } from "./main-fakes.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(agent: CliAgent) {
  const root = mkdtempSync(join(tmpdir(), "elwood-cli-preservation-"));
  roots.push(root);
  const stateDir = join(root, "state");
  const request = effectiveRequest({
    agent,
    output: "json",
    outputExplicit: true,
    stateDir,
    cwd: root,
    keep: true,
  });
  const neverLaunch = (): Promise<ElwoodAgentSession> => Promise.reject(new Error("unused"));
  return { root, stateDir, session: new HeadlessCliSession(request, "s1", neverLaunch) };
}

describe("headless CLI preserved identity", () => {
  test.each([
    "claude",
    "codex",
  ] as const)("C-CLI-08 reports only a resumable persisted %s identity", (agent) => {
    const { root, stateDir, session } = fixture(agent);
    expect(session.preservedSessionId()).toBeNull();

    prepareStateDir(stateDir);
    const provisional = createSessionRecord({ cwd: root, id: "s1", adapter: agent });
    writeSessionRecord(provisional, sessionDir(stateDir, "s1"));
    expect(session.preservedSessionId()).toBeNull();

    const resumable = { ...provisional, [agent]: { resumeId: `${agent}-native` } };
    writeSessionRecord(resumable, sessionDir(stateDir, "s1"));
    expect(session.preservedSessionId()).toBe("s1");
  });

  test("C-CLI-08 rejects a persisted identity owned by the other adapter", () => {
    const { root, stateDir, session } = fixture("codex");
    prepareStateDir(stateDir);
    const record = {
      ...createSessionRecord({ cwd: root, id: "s1", adapter: "claude" }),
      claude: { resumeId: "claude-native" },
    };
    writeSessionRecord(record, sessionDir(stateDir, "s1"));
    expect(session.preservedSessionId()).toBeNull();
  });
});
