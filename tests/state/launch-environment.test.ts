/** Child environments stay launch-local across start/resume (PRD §5.1, §5.2, §5.5, §5.6). */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { startOrResumeClaude, startOrResumeCodex } from "../../src/index.ts";
import { setCommandRunnerForTests } from "../../src/runtime/seams.ts";
import { setUpdateCoordinatorForTests } from "../../src/runtime/update/once.ts";
import {
  createSessionRecord,
  prepareStateDir,
  sessionDir,
  writeSessionRecord,
} from "../../src/state/store.ts";
import * as claude from "../claude/helpers.ts";
import * as codex from "../codex/helpers.ts";

afterEach(() => {
  claude.resetFakes();
  codex.resetFakes();
  vi.unstubAllEnvs();
});

for (const [agent, start, helpers] of [
  ["claude", startOrResumeClaude, claude],
  ["codex", startOrResumeCodex, codex],
] as const) {
  test(`C-API-26 ${agent} env overrides/removals reach fresh and resumed probes and PTYs`, async () => {
    vi.stubEnv("ELWOOD_ENV_REMOVE", "parent-only");
    vi.stubEnv("ELWOOD_ENV_INHERIT", "inherited");
    const cwd = helpers.tempDir();
    helpers.installFakes();
    setUpdateCoordinatorForTests((_adapter, run) => run());
    const environments: (Readonly<Record<string, string | undefined>> | undefined)[] = [];
    setCommandRunnerForTests((_command, args, options) => {
      environments.push(options?.env);
      return {
        status: 0,
        stdout: args.join(" ").includes("--help") ? "--dangerously-bypass-hook-trust" : "2.1.144",
        stderr: "",
      };
    });
    const stateDir = join(cwd, ".elwood");
    prepareStateDir(stateDir, { cwd });
    const record = createSessionRecord({ cwd, id: "resumable", adapter: agent });
    writeSessionRecord(
      agent === "claude"
        ? { ...record, claude: { resumeId: "native" } }
        : { ...record, codex: { resumeId: "native" } },
      sessionDir(stateDir, "resumable"),
    );
    for (const elwoodSessionId of ["absent", "resumable"]) {
      const value = elwoodSessionId;
      const env = {
        ELWOOD_ENV_VALUE: value,
        ELWOOD_ENV_REMOVE: undefined,
        ELWOOD_SESSION_ID: "wrong",
      };
      const result = await start({ cwd, stateDir, elwoodSessionId, env, autoupdate: true });
      expect(result.resumed).toBe(elwoodSessionId === "resumable");
      const child = helpers.ptys.at(-1)!.options.env;
      expect(child["ELWOOD_ENV_VALUE"]).toBe(value);
      expect(child["ELWOOD_ENV_INHERIT"]).toBe("inherited");
      expect(Object.hasOwn(child, "ELWOOD_ENV_REMOVE")).toBe(false);
      expect(child["ELWOOD_SESSION_ID"]).toBe(result.session.elwoodSessionId);
      expect(environments.at(-1)?.["ELWOOD_ENV_VALUE"]).toBe(value);
      expect(
        environments.every((entry) => entry && !Object.hasOwn(entry, "ELWOOD_ENV_REMOVE")),
      ).toBe(true);
      expect(
        readFileSync(
          join(sessionDir(stateDir, result.session.elwoodSessionId), "session.json"),
          "utf8",
        ),
      ).not.toContain("ELWOOD_ENV_VALUE");
      expect(env.ELWOOD_ENV_REMOVE).toBeUndefined();
      await result.session.stop();
    }
    expect(
      environments.filter((env) => env?.["ELWOOD_ENV_VALUE"] === "absent").length,
    ).toBeGreaterThan(0);
    expect(process.env["ELWOOD_ENV_REMOVE"]).toBe("parent-only");
    expect(process.env["ELWOOD_ENV_VALUE"]).toBeUndefined();
  });
}
