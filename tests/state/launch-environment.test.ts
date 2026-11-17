/** Child environments stay launch-local across start/resume (PRD §5.1, §5.2, §5.5, §5.6). */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { startOrResumeClaude, startOrResumeCodex } from "../../src/index.ts";
import { type CommandOptions, setCommandRunnerForTests } from "../../src/runtime/seams.ts";
import { probeShellCommand, userShell } from "../../src/runtime/shell.ts";
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

const adapters = [
  {
    agent: "claude",
    start: startOrResumeClaude,
    helpers: claude,
    native: { claude: { resumeId: "native" } },
    initialProbes: [
      probeShellCommand("claude --version", "claude"),
      probeShellCommand("claude update"),
      probeShellCommand("claude --version", "claude"),
    ],
    resumedProbes: [probeShellCommand("claude --version", "claude")],
  },
  {
    agent: "codex",
    start: startOrResumeCodex,
    helpers: codex,
    native: { codex: { resumeId: "native" } },
    initialProbes: [
      probeShellCommand("codex --version", "codex"),
      probeShellCommand("codex update"),
      probeShellCommand("codex --version", "codex"),
      probeShellCommand("codex --help"),
    ],
    resumedProbes: [
      probeShellCommand("codex --version", "codex"),
      probeShellCommand("codex --help"),
    ],
  },
] as const;

type ProbeCall = {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: CommandOptions["env"];
};

for (const { agent, start, helpers, native, initialProbes, resumedProbes } of adapters) {
  function setup() {
    const cwd = helpers.tempDir();
    helpers.installFakes();
    setUpdateCoordinatorForTests((_adapter, run) => run());
    const stateDir = join(cwd, ".elwood");
    prepareStateDir(stateDir, { cwd });
    const record = createSessionRecord({ cwd, id: "resumable", adapter: agent });
    writeSessionRecord({ ...record, ...native }, sessionDir(stateDir, "resumable"));
    return { cwd, stateDir };
  }

  const launches = [
    { elwoodSessionId: "absent", resumed: false, probes: initialProbes },
    { elwoodSessionId: "resumable", resumed: true, probes: resumedProbes },
  ];

  test(`C-API-26 ${agent} env overrides/removals reach every fresh and resumed probe and PTY`, async () => {
    vi.stubEnv("ELWOOD_ENV_REMOVE", "parent-only");
    vi.stubEnv("ELWOOD_ENV_INHERIT", "inherited");
    const { cwd, stateDir } = setup();
    const probes: ProbeCall[] = [];
    setCommandRunnerForTests((command, args, options) => {
      probes.push({ command, args, env: options?.env });
      return { status: 0, stdout: "2.1.144 --dangerously-bypass-hook-trust", stderr: "" };
    });
    for (const { elwoodSessionId, resumed, probes: expectedProbes } of launches) {
      const env = {
        ELWOOD_ENV_VALUE: elwoodSessionId,
        ELWOOD_ENV_REMOVE: undefined,
        ELWOOD_SESSION_ID: "wrong",
      };
      const before = probes.length;
      const result = await start({ cwd, stateDir, elwoodSessionId, env, autoupdate: true });
      expect(result.resumed).toBe(resumed);
      const launchProbes = probes.slice(before);
      expect(launchProbes.map(({ command, args }) => ({ command, args }))).toEqual(
        expectedProbes.map((args) => ({ command: userShell(), args })),
      );
      for (const probe of launchProbes) {
        expect(probe.env).toMatchObject({
          ELWOOD_ENV_VALUE: elwoodSessionId,
          ELWOOD_ENV_INHERIT: "inherited",
        });
        expect(Object.hasOwn(probe.env!, "ELWOOD_ENV_REMOVE")).toBe(false);
      }
      const child = helpers.ptys.at(-1)!.options.env;
      expect(child["ELWOOD_ENV_VALUE"]).toBe(elwoodSessionId);
      expect(child["ELWOOD_ENV_INHERIT"]).toBe("inherited");
      expect(Object.hasOwn(child, "ELWOOD_ENV_REMOVE")).toBe(false);
      expect(child["ELWOOD_SESSION_ID"]).toBe(result.session.elwoodSessionId);
      expect(
        readFileSync(
          join(sessionDir(stateDir, result.session.elwoodSessionId), "session.json"),
          "utf8",
        ),
      ).not.toContain("ELWOOD_ENV_VALUE");
      expect(env.ELWOOD_ENV_REMOVE).toBeUndefined();
      await result.session.stop();
    }
    expect(process.env["ELWOOD_ENV_REMOVE"]).toBe("parent-only");
    expect(process.env["ELWOOD_ENV_VALUE"]).toBeUndefined();
  });

  test(`C-API-26 ${agent} omitted env snapshots inheritance before probes and refreshes the next launch`, async () => {
    const { cwd, stateDir } = setup();
    const probes: ProbeCall[] = [];
    setCommandRunnerForTests((command, args, options) => {
      probes.push({ command, args, env: options?.env });
      vi.stubEnv("ELWOOD_ENV_VALUE", "changed-during-probe");
      return { status: 0, stdout: "2.1.144 --dangerously-bypass-hook-trust", stderr: "" };
    });
    for (const { elwoodSessionId, resumed, probes: expectedProbes } of launches) {
      vi.stubEnv("ELWOOD_ENV_VALUE", elwoodSessionId);
      const before = probes.length;
      const result = await start({ cwd, stateDir, elwoodSessionId, autoupdate: true });
      expect(result.resumed).toBe(resumed);
      const launchProbes = probes.slice(before);
      expect(launchProbes.map(({ command, args }) => ({ command, args }))).toEqual(
        expectedProbes.map((args) => ({ command: userShell(), args })),
      );
      for (const probe of launchProbes)
        expect(probe.env?.["ELWOOD_ENV_VALUE"]).toBe(elwoodSessionId);
      expect(helpers.ptys.at(-1)!.options.env["ELWOOD_ENV_VALUE"]).toBe(elwoodSessionId);
      expect(process.env["ELWOOD_ENV_VALUE"]).toBe("changed-during-probe");
      await result.session.stop();
    }
  });
}
