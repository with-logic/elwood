/**
 * A session's agent is spawned only in the directory its start or resume checked first. A
 * directory removed, or replaced even by one holding the same CLI, after a preflight probe ran
 * there or while the session's hook bridge starts fails the launch as that, and no PTY starts.
 * Codex's capability probe is the last thing a launch awaits before its spawn, so a change after
 * it is caught too. The probes run for real through a stand-in login shell. Covers PRD §5.1,
 * §5.2, §5.5, §5.6, C-API-61 and C-PTY-08.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  resetClaudeHookBridgeFactoryForTests,
  setHookBridgeFactoryForTests,
} from "../../src/claude/session/bridge.ts";
import {
  resetCodexSessionSeamsForTests,
  setCodexHookBridgeFactoryForTests,
} from "../../src/codex/session/bridge.ts";
import type { ElwoodAgentKind } from "../../src/core/activity/index.ts";
import { resumeClaude, resumeCodex, startClaude, startCodex } from "../../src/index.ts";
import {
  changeAfterProbe,
  changeDirectory,
  createResumableSessionStateDir,
  project,
  useProbeProjects,
} from "../helpers/preflight-projects.ts";

const launches = useProbeProjects();
const versions = { claude: "2.1.144 (Claude Code)", codex: "codex-cli 0.150.0" } as const;

/** Each way a session launches in `cwd`: a start there, or a resume of a session saved there. */
const launchers = [
  ["start", "claude", (cwd: string) => startClaude({ cwd })],
  ["start", "codex", (cwd: string) => startCodex({ cwd })],
  ["resume", "claude", (cwd: string) => resumed("claude", cwd)],
  ["resume", "codex", (cwd: string) => resumed("codex", cwd)],
] as const;

/** When a launch's directory changes, in the order a launch reaches them, and how. */
type Moment = readonly [string, (cwd: string, replacement?: string) => void];

function moments(agent: ElwoodAgentKind): readonly Moment[] {
  const afterProbe = (flag: string): Moment => [
    `after its ${flag} probe`,
    (cwd, replacement) => changeAfterProbe(cwd, `${agent} ${flag}`, replacement),
  ];
  const asBridgeStarts: Moment = [
    "as its hook bridge starts, after preflight and its state",
    (cwd, replacement) => {
      const bridge = () => ({
        start: async () => changeDirectory(cwd, replacement),
        stop: async () => undefined,
      });
      if (agent === "claude") setHookBridgeFactoryForTests(bridge);
      else setCodexHookBridgeFactoryForTests(bridge);
    },
  ];
  return agent === "claude"
    ? [afterProbe("--version"), asBridgeStarts]
    : [afterProbe("--version"), asBridgeStarts, afterProbe("--help")];
}

function resumed(agent: ElwoodAgentKind, cwd: string): Promise<unknown> {
  const stateDir = createResumableSessionStateDir(agent, cwd);
  const elwoodSessionId = `${agent}-probe-cwd`;
  return agent === "claude"
    ? resumeClaude({ stateDir, elwoodSessionId })
    : resumeCodex({ stateDir, elwoodSessionId });
}

/** How a checked directory can change before the spawn, and the launch failure each gives. */
const changes = [
  {
    how: "replaced",
    message: "The working directory (`cwd`) was replaced by another directory.",
    details: (cwd: string) => ({ cwd }),
  },
  {
    // Whichever step meets the missing directory first fails the launch, with its own cause.
    how: "removed",
    message: "The working directory (`cwd`) is not an existing directory.",
    details: (cwd: string) => expect.objectContaining({ cwd, errno: "ENOENT" }),
  },
] as const;

afterEach(() => {
  resetClaudeHookBridgeFactoryForTests();
  resetCodexSessionSeamsForTests();
});

describe.each(launchers)("a %s of %s", (_kind, agent, launch) => {
  describe.each(changes)("whose directory is $how", (change) => {
    test.each(
      moments(agent),
    )("C-API-61 C-PTY-08 %s spawns no agent and fails as that", async (_when, changeAt) => {
      const cwd = project(agent, versions[agent]);
      changeAt(cwd, change.how === "replaced" ? project(agent, versions[agent]) : undefined);
      await expect(launch(cwd)).rejects.toEqual(
        expect.objectContaining({
          code: `${agent}_start_failed`,
          message: change.message,
          details: change.details(cwd),
        }),
      );
      expect(launches).toEqual([]);
      expect(existsSync(join(cwd, ".elwood")), "no state is written in a replacement").toBe(false);
    });
  });

  test("C-PTY-08 whose directory stays the one it checked spawns its agent there", async () => {
    const cwd = project(agent, versions[agent]);
    await expect(launch(cwd)).rejects.toMatchObject({ code: "pty_start_failed" }); // no PTY here
    expect(launches.map((spawned) => spawned.cwd)).toEqual([cwd]);
  });
});
