/** Real PTY starts and resumes carry the checked identity past login profiles (C-API-61). */
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { resumeClaude, resumeCodex, startClaude, startCodex } from "../../src/index.ts";
import { nodePtyFactory } from "../../src/pty/node.ts";
import { setPtyFactoryForTests } from "../../src/runtime/seams.ts";
import {
  createResumableSessionStateDir,
  dir,
  project,
  useProbeProjects,
} from "../helpers/preflight-projects.ts";

useProbeProjects();
const agents = [
  ["claude", startClaude, resumeClaude, "2.1.144 (Claude Code)"],
  ["codex", startCodex, resumeCodex, "codex-cli 0.150.0"],
] as const;

for (const kind of ["start", "resume"] as const) {
  test.each(
    agents,
  )(`C-API-61 a real PTY ${kind} of %s refuses a profile swap after the initial guard`, async (agent, start, resume, version) => {
    const cwd = project(agent, version);
    const original = join(dir("elwood-pty-original-"), "kept");
    const replacement = project(agent, version);
    const marker = join(dir("elwood-pty-replacement-"), "ran");
    writeFileSync(join(replacement, "bin", agent), `#!/bin/sh\ntouch '${marker}'\n`);
    const stateDir = kind === "resume" ? createResumableSessionStateDir(agent, cwd) : undefined;
    let spawned = false;
    setPtyFactoryForTests((options) => {
      spawned = true;
      expect(options.directoryIdentity).toBeDefined();
      // Only arm the swap after every probe passed, at the real PTY boundary.
      writeFileSync(
        join(cwd, "swap-on-login"),
        `rm swap-on-login; mv "$PWD" '${original}'; mv '${replacement}' "$PWD"\n`,
      );
      return nodePtyFactory(options);
    });
    try {
      const launch =
        stateDir === undefined
          ? start({ cwd })
          : resume({ stateDir, elwoodSessionId: `${agent}-probe-cwd` });
      await expect(launch).rejects.toMatchObject({
        code: `${agent}_start_failed`,
        details: { cwd },
      });
      expect(spawned).toBe(true);
      expect(existsSync(original), "the PTY profile ran after the initial guard").toBe(true);
      expect(existsSync(marker), "the replacement CLI never ran").toBe(false);
    } finally {
      if (existsSync(original)) {
        renameSync(cwd, replacement);
        renameSync(original, cwd);
      }
    }
  });
}
