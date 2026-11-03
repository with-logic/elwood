/** C-API-61 rechecks failed cwd-scoped preflights before reporting missing CLIs. */
import { rmSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import { resumeClaude, resumeCodex, startClaude, startCodex } from "../../src/index.ts";
import { setCommandRunnerForTests, setPlatformForTests } from "../../src/runtime/seams.ts";
import { fakeLaunch, resetFakeLaunch } from "../helpers/fake-launch.ts";
import { replaceDirectory } from "../helpers/replace-directory.ts";
import { resumableStateDir } from "../helpers/session-state.ts";
import { tempDir } from "../helpers/tmp.ts";

afterEach(resetFakeLaunch);

describe.each([
  { agent: "claude", start: startClaude, resume: resumeClaude },
  { agent: "codex", start: startCodex, resume: resumeCodex },
] as const)("$agent failed preflight", ({ agent, start, resume }) => {
  for (const mode of ["start", "resume"] as const) {
    test.each([
      "removed",
      "replaced",
      "unchanged",
    ] as const)(`C-API-61 ${mode} classifies ENOENT with a %s launch directory`, async (change) => {
      const cwd = tempDir("elwood-preflight-failed-cwd-");
      const id = `${agent}-failed-preflight`;
      const stateDir = resumableStateDir(agent, cwd, id);
      const launched = fakeLaunch();
      setCommandRunnerForTests(() => {
        if (change === "removed") rmSync(cwd, { recursive: true });
        if (change === "replaced") replaceDirectory(cwd);
        return {
          status: null,
          stdout: "",
          stderr: "",
          error: {
            code: "ENOENT",
            message: "spawn missing shell",
            syscall: "spawn",
            path: "/missing-shell",
          },
        };
      });
      const result = mode === "start" ? start({ cwd }) : resume({ elwoodSessionId: id, stateDir });
      if (change === "unchanged") {
        await expect(result).rejects.toMatchObject({ code: `${agent}_not_found` });
      } else {
        const error = await result.catch((error: unknown) => error);
        expect(error).toMatchObject({ code: `${agent}_start_failed`, details: { cwd } });
        if (change === "removed") expect(error).toMatchObject({ details: { errno: "ENOENT" } });
        else
          expect(error).toMatchObject({
            message: "The working directory (`cwd`) was replaced by another directory.",
            details: expect.not.objectContaining({ errno: expect.anything() }),
          });
      }
      expect(launched).toEqual([]);
    });
    test(`C-API-61 ${mode} preserves unsupported-platform precedence`, async () => {
      const cwd = tempDir("elwood-preflight-platform-");
      const id = `${agent}-unsupported`;
      const stateDir = resumableStateDir(agent, cwd, id);
      fakeLaunch();
      setPlatformForTests("linux");
      rmSync(cwd, { recursive: true });
      const result = mode === "start" ? start({ cwd }) : resume({ elwoodSessionId: id, stateDir });
      await expect(result).rejects.toMatchObject({ code: "unsupported_platform" });
    });
  }
});
