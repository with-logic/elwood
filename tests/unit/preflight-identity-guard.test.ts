/** Initially checked identities must reach real probes and PTYs (C-API-61, C-PTY-08). */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import * as claude from "../../src/claude/preflight.ts";
import * as codex from "../../src/codex/preflight.ts";
import { startClaude, startCodex } from "../../src/index.ts";
import { nodePtyFactory } from "../../src/pty/node.ts";
import { setPtyFactoryForTests } from "../../src/runtime/seams.ts";
import { changeDirectory, dir, project, useProbeProjects } from "../helpers/preflight-projects.ts";

useProbeProjects();
const cases = [
  ["claude", startClaude, "2.1.144 (Claude Code)"],
  ["codex", startCodex, "codex-cli 0.150.0"],
] as const;

test.each(
  cases,
)("C-API-61 %s refuses a replacement before a probe captures its key", async (agent, start, version) => {
  const cwd = project(agent, version);
  const replacement = project(agent, version);
  const marker = join(dir("elwood-untrusted-cli-"), "ran");
  writeFileSync(
    join(replacement, "bin", agent),
    `#!/bin/sh\ntouch '${marker}'; echo '${version}'\n`,
  );
  if (agent === "claude") {
    const real = claude.preflightClaude;
    vi.spyOn(claude, "preflightClaude").mockImplementation((...args) => {
      changeDirectory(cwd, replacement);
      return real(...args);
    });
  } else {
    const real = codex.preflightCodex;
    vi.spyOn(codex, "preflightCodex").mockImplementation((...args) => {
      changeDirectory(cwd, replacement);
      return real(...args);
    });
  }
  await expect(start({ cwd })).rejects.toMatchObject({
    code: `${agent}_start_failed`,
    details: { cwd },
  });
  expect(existsSync(marker)).toBe(false);
});

test.each(
  cases,
)("C-PTY-08 %s refuses a profile's path swap before the replacement CLI can restore it", async (agent, start, version) => {
  const cwd = project(agent, version);
  const original = join(dir("elwood-kept-directory-"), "original");
  const replacement = project(agent, version);
  const marker = join(dir("elwood-profile-cli-"), "ran");
  writeFileSync(
    join(cwd, "swap-on-login"),
    `rm swap-on-login; mv "$PWD" '${original}'; mv '${replacement}' "$PWD"\n`,
  );
  writeFileSync(
    join(replacement, "bin", agent),
    `#!/bin/sh\ntouch '${marker}'; mv '${cwd}' '${replacement}'; mv '${original}' '${cwd}'; echo '${version}'\n`,
  );
  try {
    await expect(start({ cwd })).rejects.toMatchObject({
      code: `${agent}_start_failed`,
      details: { cwd },
    });
    expect(existsSync(marker)).toBe(false);
  } finally {
    if (existsSync(original)) {
      renameSync(cwd, replacement);
      renameSync(original, cwd);
    }
  }
});

test.each(
  cases,
)("C-API-61 %s validates the real PTY cwd before its login shell loads a profile", async (agent, start, version) => {
  const cwd = project(agent, version);
  const replacement = project(agent, version);
  const marker = join(dir("elwood-pty-cli-"), "ran");
  writeFileSync(join(replacement, "bin", agent), `#!/bin/sh\ntouch '${marker}'\n`);
  setPtyFactoryForTests((options) => {
    changeDirectory(cwd, replacement);
    return nodePtyFactory(options);
  });
  await expect(start({ cwd })).rejects.toMatchObject({ code: `${agent}_start_failed` });
  expect(existsSync(marker)).toBe(false);
});

test.each(
  cases,
)("C-PTY-08 %s autoupdate runs in its initially checked directory", async (agent, start, version) => {
  const cwd = project(agent, version);
  await expect(start({ cwd, autoupdate: true })).rejects.toMatchObject({
    code: "pty_start_failed",
  });
  expect(readFileSync(join(cwd, "updated-in"), "utf8").trim()).toBe(cwd);
});
