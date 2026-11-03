/** Real login shells keep inherited writers owned, including silent holders (C-PERF-03/05). */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import {
  resetProbeTimeoutsForTests,
  runProbe,
  setProbeTimeoutsForTests,
} from "../../src/runtime/probe/index.ts";
import { probeShellCommand, shellQuote } from "../../src/runtime/shell.ts";
import { killGroupsWhoseCommandHas, pollGone, processRows } from "../helpers/process-liveness.ts";
import { tempDir } from "../helpers/tmp.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  resetProbeTimeoutsForTests();
});

for (const shell of ["/bin/zsh", "/bin/bash"] as const) {
  test.skipIf(!existsSync(shell))(
    `C-PERF-03 ${shell} keeps the group owner alive through a silent inherited FIFO writer`,
    async () => {
      const root = tempDir("elwood-probe-silent-owner-");
      const holder = join(root, "silent-holder");
      const pidPath = join(root, "pid");
      const groupPath = join(root, "group");
      writeFileSync(
        holder,
        `#!/bin/sh\necho $$ > ${shellQuote(pidPath)}\n/bin/ps -o pgid= -p $$ > ${shellQuote(groupPath)}\nwhile :; do /bin/sleep 1; done\n`,
        { mode: 0o700 },
      );
      vi.stubEnv("ZDOTDIR", root);
      vi.stubEnv("HOME", root);
      vi.stubEnv("TERM_PROGRAM", "");
      setProbeTimeoutsForTests({ commandMs: 2_000, launchMs: 10_000 });
      // Command exits; this uniquely named descendant silently keeps both output pipes open.
      const command = `/bin/sh -c ${shellQuote(`${shellQuote(holder)} & exit 0`)}`;
      const pending = runProbe(shell, probeShellCommand(command));
      try {
        await vi.waitFor(() => {
          expect(readFileSync(pidPath, "utf8")).toMatch(/\d+/);
          expect(readFileSync(groupPath, "utf8")).toMatch(/\d+/);
        });
        const pid = Number(readFileSync(pidPath, "utf8"));
        const pgid = Number(readFileSync(groupPath, "utf8"));
        const owner = processRows().find((row) => row.pid === pgid);
        expect((await pending).error).toMatchObject({ code: "ETIMEDOUT" });
        expect(await pollGone({ pid, timeoutMs: 3_000 })).toBe(true);
        expect(owner?.command).toContain("elwood-probe-supervisor");
        expect(owner?.stat.startsWith("Z")).toBe(false);
      } finally {
        killGroupsWhoseCommandHas(root);
        await pending;
      }
    },
    20_000,
  );
}

test("C-PERF-03 an otherwise idle host awaits its probe result and inherited output", async () => {
  const root = tempDir("elwood-probe-idle-runner-");
  const fixture = join(root, "host.mjs");
  const runtime = new URL("../../src/runtime/probe/index.ts", import.meta.url).href;
  const shell = new URL("../../src/runtime/shell.ts", import.meta.url).href;
  const command = "/bin/sh -c '(sleep 0.3; echo late) & echo early'";
  writeFileSync(
    fixture,
    `import {runProbe} from ${JSON.stringify(runtime)}; import {probeShellCommand} from ${JSON.stringify(shell)}; console.log(JSON.stringify(await runProbe('/bin/sh', probeShellCommand(${JSON.stringify(command)}))));`,
  );
  const result = await promisify(execFile)(process.execPath, ["--no-warnings", fixture], {
    timeout: 10_000,
  });
  expect(JSON.parse(result.stdout)).toEqual({ status: 0, stdout: "early\nlate\n", stderr: "" });
});

for (const shell of ["/bin/zsh", "/bin/bash"] as const) {
  for (const [signal, status] of [
    ["TERM", 143],
    ["INT", 130],
  ] as const) {
    test.skipIf(!existsSync(shell))(
      `C-PERF-03 ${shell} preserves command signal ${signal} as status ${status}`,
      async () => {
        const home = tempDir("elwood-probe-signal-home-");
        vi.stubEnv("HOME", home);
        vi.stubEnv("ZDOTDIR", home);
        vi.stubEnv("TERM_PROGRAM", "");
        const command = `/bin/sh -c ${shellQuote(`kill -${signal} $$`)}`;
        expect(await runProbe(shell, probeShellCommand(command))).toEqual({
          status,
          stdout: "",
          stderr: "",
        });
      },
    );
  }
}

test("C-PERF-05 probe command stdin is EOF rather than an unfulfilled input pipe", async () => {
  expect(await runProbe("/bin/sh", ["-c", probeShellCommand("/bin/cat")[3]])).toEqual({
    status: 0,
    stdout: "",
    stderr: "",
  });
});

test.skipIf(!existsSync("/bin/bash"))(
  "C-PERF-05 supervisor protocol ignores exported shell functions",
  async () => {
    const home = tempDir("elwood-probe-private-supervisor-");
    vi.stubEnv("HOME", home);
    vi.stubEnv("ZDOTDIR", home);
    vi.stubEnv("TERM_PROGRAM", "");
    vi.stubEnv("BASH_FUNC_printf%%", "() { echo PRIVATE-SUPERVISOR-OVERRIDE; }");
    expect(await runProbe("/bin/bash", probeShellCommand("/usr/bin/printf wanted"))).toEqual({
      status: 0,
      stdout: "wanted",
      stderr: "",
    });
  },
);
