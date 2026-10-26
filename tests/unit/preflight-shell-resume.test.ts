/**
 * On resume, the directory the session relaunches in answers its preflight and is where its
 * PTY starts, never Elwood's own directory: Claude's is the `cwd` given, else the record's;
 * Codex always relaunches in the record's, with the capabilities of the codex there, and a
 * directory lost as its CLI is probed fails the resume as that directory. The probes run for real through a stand-in login shell. Covers PRD
 * §4.2, §9.2, C-PTY-08, and C-API-61.
 */

import { describe, expect, test } from "vitest";
import { resumeClaude, resumeCodex } from "../../src/index.ts";
import {
  bypassByDirectory,
  createResumableSessionStateDir,
  dir,
  directoryLossCases,
  hookTrustBypass,
  lostDirectory,
  oldClaude,
  oldCodex,
  project,
  removeWhenProbed,
  useProbeProjects,
} from "../helpers/preflight-projects.ts";

const launches = useProbeProjects();
const ptyFailure = { code: "pty_start_failed" };

test("C-PTY-08 resumeCodex checks the codex of its saved directory, where it relaunches", async () => {
  const stateDir = createResumableSessionStateDir("codex", project("codex", "codex-cli 0.100.0"));
  const resumed = resumeCodex({
    cwd: project("codex", "codex-cli 0.150.0"),
    stateDir,
    elwoodSessionId: "codex-probe-cwd",
    strictVersionCheck: true,
  });
  await expect(resumed).rejects.toMatchObject(oldCodex);
  expect(launches).toEqual([]);
});

test("C-PTY-08 resumeCodex launches with the capabilities of the codex in its saved directory", async () => {
  const saved = [hookTrustBypass, "no such flag"].map((help) =>
    project("codex", "codex-cli 0.150.0", help),
  );
  for (const cwd of saved) {
    const stateDir = createResumableSessionStateDir("codex", cwd);
    // `cwd` only locates the state; Codex relaunches in the saved directory.
    const elsewhere = project("codex", "codex-cli 0.150.0", "no such flag");
    const resumed = resumeCodex({ cwd: elsewhere, stateDir, elwoodSessionId: "codex-probe-cwd" });
    await expect(resumed).rejects.toMatchObject(ptyFailure);
  }
  expect(bypassByDirectory(launches)).toEqual([
    [saved[0], true],
    [saved[1], false],
  ]);
});

test("C-PTY-08 resumeClaude checks, and launches in, the directory it is given", async () => {
  const stateDir = createResumableSessionStateDir("claude", project("claude", "2.1.100"));
  const cwd = project("claude", "2.1.144 (Claude Code)");
  const resumed = resumeClaude({ cwd, stateDir, elwoodSessionId: "claude-probe-cwd" });
  await expect(resumed).rejects.toMatchObject(ptyFailure);
  expect(launches.map((launch) => launch.cwd)).toEqual([cwd]);
});

test("C-PTY-08 resumeClaude without a cwd checks, and launches in, its saved directory", async () => {
  const saved = project("claude", "2.1.144 (Claude Code)");
  expect(process.cwd()).not.toBe(saved); // so falling back to Elwood's own directory would differ
  const stateDir = createResumableSessionStateDir("claude", saved);
  const resumed = resumeClaude({ stateDir, elwoodSessionId: "claude-probe-cwd" });
  await expect(resumed).rejects.toMatchObject(ptyFailure);
  expect(launches.map((launch) => launch.cwd)).toEqual([saved]);
});

test("C-PTY-08 resumeClaude without a cwd refuses its saved directory's old claude", async () => {
  const stateDir = createResumableSessionStateDir("claude", project("claude", "2.1.100"));
  const resumed = resumeClaude({
    stateDir,
    elwoodSessionId: "claude-probe-cwd",
    strictVersionCheck: true,
  });
  await expect(resumed).rejects.toMatchObject(oldClaude);
  expect(launches).toEqual([]);
});

describe.each(directoryLossCases)("a directory $how", ({ remade, message, errno }) => {
  test.each([
    ["codex", resumeCodex, "codex-cli 0.150.0"],
    ["claude", resumeClaude, "2.1.144 (Claude Code)"],
  ] as const)("C-PTY-08 C-API-61 a %s resume whose directory goes as its CLI is probed fails as that, with the probe's cause", async (agent, resume, version) => {
    const cwd = project(agent, version);
    const stateDir = createResumableSessionStateDir(agent, cwd);
    removeWhenProbed(cwd, remade ? dir("elwood-preflight-replacement-") : undefined);
    const resumed = resume({ stateDir, elwoodSessionId: `${agent}-probe-cwd` });
    await expect(resumed).rejects.toMatchObject({
      code: `${agent}_start_failed`,
      message,
      details: lostDirectory(cwd, errno),
    });
    expect(launches).toEqual([]);
  });
});
