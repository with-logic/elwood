/**
 * A named-pipe capture: two pipes in a private 0700 `elwood-probe-*` directory under the temp
 * directory, which a command `exec`ed into them writes and Elwood reads as it would the
 * command's own pipes, and which is removed however the capture ends (PRD §9.2, C-PERF-03,
 * C-PERF-05). The capture is driven directly, as a probe runner drives it, and real shells
 * write into it. Each test points TMPDIR at a directory of its own and checks that the
 * capture left it empty. A host with nothing else to do stays alive until the capture ends.
 */

import { execFile, spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { maxProbeStreamOutputBytes } from "../../src/runtime/probe/capped-buffer.ts";
import { NamedPipeCapture, setMkfifoForTests } from "../../src/runtime/probe/named-pipes.ts";
import { probeOutputRedirect } from "../../src/runtime/probe/start.ts";
import { shellQuote } from "../../src/runtime/shell.ts";
import { tempDir } from "../helpers/tmp.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  setMkfifoForTests();
});

/** A TMPDIR of the test's own, which a capture must leave empty. */
function privateTmp(): string {
  const tmp = tempDir("elwood-capture-tmpdir-");
  vi.stubEnv("TMPDIR", tmp);
  return tmp;
}

/** `script` run by `/bin/sh` as the captured command. */
const sh = (script: string) => `/bin/sh -c ${shellQuote(script)}`;

/**
 * The capture's directory, as its command finds it: the only `elwood-probe-*` entry in the
 * test's own TMPDIR. The command is never told its path.
 */
const ownDirectory = `"\${TMPDIR:?}"/elwood-probe-*`;

type Captured = {
  readonly outcome: "ended" | "overflowed" | "released" | "timed out";
  readonly exit: string;
  readonly stdout: string;
  readonly stderr: string;
};

/** How long a capture may take before the test gives up on it, inside the test's own timeout. */
const captureBoundMs = 10_000;

type CaptureOptions = {
  /** Script run before the `exec`. */
  readonly prelude?: string;
  /** Releases the capture once its stdout satisfies this, as a probe's bound would end it. */
  readonly releaseWhen?: (stdout: string) => boolean;
};

/**
 * `exec`s `command` into a new capture and reads it until it ends or overflows, or until
 * `releaseWhen` holds; then releases it. One that does none of these within the bound reads as
 * timed out: it is released all the same, and its shell, the test's own child, is killed.
 */
async function capture(command: string, options: CaptureOptions = {}): Promise<Captured> {
  const capture = await NamedPipeCapture.create();
  const script = `${options.prelude ?? ""}exec ${command} ${probeOutputRedirect}`;
  const child = spawn("/bin/sh", [...capture.args(["-c", script])], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<string>((resolve) =>
    child.once("exit", (code, signal) => resolve(signal ?? String(code))),
  );
  const timers: ReturnType<typeof setTimeout>[] = [];
  const outcome = await new Promise<Captured["outcome"]>((resolve) => {
    timers.push(setTimeout(() => resolve("timed out"), captureBoundMs));
    const { releaseWhen } = options;
    if (releaseWhen !== undefined) {
      timers.push(setInterval(() => releaseWhen(capture.text()[0]) && resolve("released"), 10));
    }
    capture.watch(child, {
      ended: () => resolve("ended"),
      overflowed: () => resolve("overflowed"),
    });
  });
  for (const timer of timers) clearInterval(timer);
  const [stdout, stderr] = capture.text();
  capture.release(); // a writer held at the cap is stopped by SIGPIPE
  if (outcome === "timed out") child.kill("SIGKILL");
  return { outcome, exit: await exited, stdout, stderr };
}

test("C-PERF-05 the command writes into private named pipes, in a 0700 directory removed after", async () => {
  const tmp = privateTmp();
  const result = await capture(sh(`ls -ld ${ownDirectory} ${ownDirectory}/*`));
  expect(result).toMatchObject({ outcome: "ended", exit: "0", stderr: "" });
  const [dir, stderr, stdout] = result.stdout.trim().split("\n");
  expect(dir).toMatch(/^drwx------/);
  expect(dir).toContain(` ${join(tmp, "elwood-probe-")}`);
  for (const pipe of [stderr, stdout]) expect(pipe).toMatch(/^prw-------/);
  expect(readdirSync(tmp)).toEqual([]);
});

const lockOwnDirectory = `d=$(echo ${ownDirectory}) && mkdir "$d/inner" && chmod 000 "$d/inner" "$d"`;

test.each([
  ["a non-zero exit", sh("exit 3"), "3"],
  ["a signal death", sh("kill -TERM $$"), "SIGTERM"],
  ["a command that locks its directory", sh(lockOwnDirectory), "0"],
  ["a command that removes its directory", sh(`rm -rf ${ownDirectory}`), "0"],
])("C-PERF-05 the private directory is removed after %s", async (_, command, exit) => {
  const tmp = privateTmp();
  expect(await capture(command)).toMatchObject({ outcome: "ended", exit });
  // A directory the command changed is removed off the event loop, so it may outlast release.
  await vi.waitFor(() => expect(readdirSync(tmp)).toEqual([]));
});

test("C-PERF-05 a tree the command leaves in its directory is removed after release", async () => {
  const tmp = privateTmp();
  const tree = `d=$(echo ${ownDirectory}) && mkdir "$d/tree" && cd "$d/tree" && touch $(seq 1 200)`;
  expect(await capture(sh(tree))).toMatchObject({ outcome: "ended", exit: "0" });
  // Still there as release returns: its removal did not hold up the event loop.
  expect(readdirSync(tmp)).toHaveLength(1);
  await vi.waitFor(() => expect(readdirSync(tmp)).toEqual([]));
});

test.each([
  ["stdout", "yes", "stdout"],
  ["stderr", sh("yes >&2"), "stderr"],
  ["stdout, from a command that exits over it", sh("head -c 1000001 /dev/zero"), "stdout"],
] as const)("C-PERF-03 a command writing past the cap on %s overflows, keeping exactly the cap", async (_, command, stream) => {
  const tmp = privateTmp();
  const result = await capture(command);
  expect(result.outcome).toBe("overflowed");
  expect(result[stream]).toHaveLength(maxProbeStreamOutputBytes);
  expect(readdirSync(tmp)).toEqual([]);
});

test("C-PERF-03 the capture waits for what its command started that still holds its output", async () => {
  const tmp = privateTmp();
  const result = await capture(sh("(sleep 0.3; echo late; echo late >&2) & echo early"));
  expect(result).toEqual({
    outcome: "ended",
    exit: "0",
    stdout: "early\nlate\n",
    stderr: "late\n",
  });
  expect(readdirSync(tmp)).toEqual([]);
});

test("C-PERF-03 the capture waits for a shell that reaches its exec late, as after a slow profile", async () => {
  const result = await capture("echo late", { prelude: "sleep 0.3; " });
  expect(result).toEqual({ outcome: "ended", exit: "0", stdout: "late\n", stderr: "" });
});

test("C-PERF-03 a writer left when the capture is released is killed by SIGPIPE", async () => {
  privateTmp();
  const status = join(tempDir("elwood-capture-writer-"), "status");
  // A helper the command leaves behind writes a line every 50 ms, for at most 5 s. Its parent
  // records how it ended: 141 (128 + SIGPIPE) if the signal killed it, 99 if a write failed
  // without one, 0 if it was never stopped. The capture is released once the first line is
  // read: the helper has its output open by then, and is still writing.
  const writer = "i=0; while [ $i -lt 100 ]; do echo x || exit 99; i=$((i+1)); sleep 0.05; done";
  const result = await capture(sh(`( (${writer}); echo $? > ${status} ) & exit 0`), {
    releaseWhen: (stdout) => stdout !== "",
  });
  expect(result).toMatchObject({ outcome: "released", exit: "0" });
  await vi.waitFor(() => expect(readFileSync(status, "utf8")).toBe("141\n"), { timeout: 6_000 });
}, 20_000);

test("C-PERF-03 an otherwise idle host stays alive for a capture that outlives its command", async () => {
  const fixture = fileURLToPath(new URL("../fixtures/probe-idle-host.ts", import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, ["--no-warnings", fixture], {
    timeout: 20_000,
  });
  expect(JSON.parse(stdout)).toEqual(["early\nlate\n", ""]);
});
