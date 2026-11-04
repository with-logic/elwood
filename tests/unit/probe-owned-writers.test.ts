/** Real FIFO writers remain owned, including hidden-marker aborts (PRD §9.2, C-PERF-03/05). */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { runProbe, setProbeTimeoutsForTests } from "../../src/runtime/probe/index.ts";
import { ProbeProcess } from "../../src/runtime/probe/process.ts";
import { probeCommandStartLine } from "../../src/runtime/probe/start.ts";
import { probeShellCommand, shellQuote } from "../../src/runtime/shell.ts";
import { holdProbeBoundUntilReady } from "../helpers/hold-probe-bound.ts";
import { killGroupsWhoseCommandHas, pollGone } from "../helpers/process-liveness.ts";
import { tempDir } from "../helpers/tmp.ts";

const nativeKill = process.kill.bind(process);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** Private bash startup hides both start-marker channels, but the command has its own FIFOs. */
function hiddenWriter(root: string, body: string): readonly string[] {
  const rc = join(root, "profile");
  const writer = join(root, "writer");
  writeFileSync(rc, "exec 3>&-; exec >/dev/null\n");
  writeFileSync(writer, `#!/bin/sh\necho $$ > ${shellQuote(join(root, "pid"))}\n${body}\n`, {
    mode: 0o700,
  });
  const command = `/bin/sh -c ${shellQuote(`${shellQuote(writer)} & while [ ! -f ${shellQuote(join(root, "pid"))} ]; do /bin/sleep 0.01; done; exit 0`)}`;
  return ["--rcfile", rc, "-i", "-c", probeShellCommand(command)[3]];
}

/** Observe the real command-exit report without replacing any process behavior. */
function observeExit(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const original = ProbeProcess.prototype.onExit;
  vi.spyOn(ProbeProcess.prototype, "onExit").mockImplementation(function (
    this: ProbeProcess,
    listener,
  ) {
    original.call(this, (code, signal) => {
      resolve();
      listener(code, signal);
    });
  });
  return promise;
}

test("C-PERF-05 an unobserved marker still waits for inherited output EOF", async () => {
  const root = tempDir("elwood-hidden-writer-");
  const release = join(root, "release");
  const exited = observeExit();
  setProbeTimeoutsForTests({ commandMs: 10_000, launchMs: 10_000 });
  const args = hiddenWriter(
    root,
    `while [ ! -f ${shellQuote(release)} ]; do /bin/sleep 0.02; done; echo late`,
  );
  let settled = false;
  const pending = runProbe("/bin/bash", args).then((result) => {
    settled = true;
    return result;
  });
  try {
    await exited;
    await setImmediate();
    expect(settled).toBe(false);
    writeFileSync(release, "");
    expect(await pending).toMatchObject({
      status: null,
      stdout: "late\n",
      error: { phase: "login_shell" },
    });
  } finally {
    writeFileSync(release, "");
    killGroupsWhoseCommandHas(root);
    await pending;
  }
});

test("C-PERF-03 abort keeps its owner after stdin closes and a first group signal fails", async () => {
  const root = tempDir("elwood-hidden-abort-");
  const exited = observeExit();
  const args = hiddenWriter(root, "while :; do /bin/sleep 1; done");
  setProbeTimeoutsForTests({ commandMs: 10_000, launchMs: 2_000 });
  const allowDeadline = holdProbeBoundUntilReady(2_000);
  let kills = 0;
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (signal === "SIGKILL" && kills++ === 0)
      throw Object.assign(new Error("first refused"), { code: "EPERM" });
    return nativeKill(pid, signal);
  });
  const pending = runProbe("/bin/bash", args);
  try {
    await exited;
    await vi.waitFor(() => expect(readFileSync(join(root, "pid"), "utf8")).toMatch(/\d+/));
    const pid = Number(readFileSync(join(root, "pid"), "utf8"));
    allowDeadline();
    expect((await pending).error).toMatchObject({ code: "ETIMEDOUT" });
    expect(kills).toBeGreaterThan(1);
    expect(await pollGone({ pid, timeoutMs: 3_000 })).toBe(true);
  } finally {
    allowDeadline();
    vi.restoreAllMocks();
    killGroupsWhoseCommandHas(root);
    await pending;
  }
});

test.skipIf(!existsSync("/bin/zsh"))(
  "C-PERF-05 settling closes a persistent profile stderr writer",
  async () => {
    const root = tempDir("elwood-profile-drainer-");
    const writer = join(root, "profile-writer");
    writeFileSync(
      writer,
      `#!/bin/sh\necho $$ > ${shellQuote(join(root, "pid"))}\nwhile /usr/bin/printf FAKE-SECRET >&2; do /bin/sleep 0.03; done\n`,
      { mode: 0o700 },
    );
    writeFileSync(
      join(root, ".zshrc"),
      `${shellQuote(writer)} &!\nwhile [ ! -f ${shellQuote(join(root, "pid"))} ]; do /bin/sleep 0.01; done\n`,
    );
    vi.stubEnv("ZDOTDIR", root);
    vi.stubEnv("TERM_PROGRAM", "");
    try {
      expect(await runProbe("/bin/zsh", probeShellCommand("/usr/bin/printf wanted"))).toEqual({
        status: 0,
        stdout: "wanted",
        stderr: "",
      });
      await vi.waitFor(() => expect(readFileSync(join(root, "pid"), "utf8")).toMatch(/\d+/));
      expect(
        await pollGone({ pid: Number(readFileSync(join(root, "pid"), "utf8")), timeoutMs: 2_000 }),
      ).toBe(true);
    } finally {
      killGroupsWhoseCommandHas(root);
    }
  },
);

test("C-PERF-05 a POSIX shell handoff receives EOF on stdin", async () => {
  expect(await runProbe("/bin/sh", ["-c", probeShellCommand("/bin/cat")[3]])).toEqual({
    status: 0,
    stdout: "",
    stderr: "",
  });
});

test("C-PERF-05 a PATH-resolved POSIX shell uses the same clean handoff", async () => {
  vi.stubEnv("PATH", "/bin:/usr/bin");
  expect(await runProbe("sh", ["-c", probeShellCommand("echo wanted")[3]])).toEqual({
    status: 0,
    stdout: "wanted\n",
    stderr: "",
  });
});

test("C-PERF-05 CLI output equal to the private start line is preserved", async () => {
  const root = tempDir("elwood-probe-marker-output-");
  const rc = join(root, "profile");
  writeFileSync(rc, "exec 3>&-\n");
  const script = probeShellCommand(
    `/usr/bin/printf ${shellQuote(`${probeCommandStartLine}\n`)}`,
  )[3];
  expect(await runProbe("/bin/bash", ["--rcfile", rc, "-i", "-c", script])).toEqual({
    status: 0,
    stdout: `${probeCommandStartLine}\n`,
    stderr: "",
  });
});

test("C-PERF-05 a native constructor rejection releases private output setup", async () => {
  const root = tempDir("elwood-invalid-probe-");
  vi.stubEnv("TMPDIR", root);
  await expect(runProbe("invalid\0", probeShellCommand("echo wanted"))).rejects.toMatchObject({
    code: "ERR_INVALID_ARG_VALUE",
  });
  expect(readdirSync(root)).toEqual([]);
});

test("C-PERF-05 bash exec wrappers print nothing into command capture", async () => {
  const rc = join(tempDir("elwood-bash-exec-"), "profile");
  writeFileSync(rc, 'exec(){ echo FAKE-SECRET >&2; builtin exec "$@"; }; export -f exec\n');
  expect(
    await runProbe("/bin/bash", [
      "--rcfile",
      rc,
      "-i",
      "-c",
      probeShellCommand("/usr/bin/printf wanted")[3],
    ]),
  ).toEqual({ status: 0, stdout: "wanted", stderr: "" });
});
