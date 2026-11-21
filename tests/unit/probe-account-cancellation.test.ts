/** Account quota cancellation releases probe resources (PRD §5.12, C-STATS-05). */
import { getEventListeners } from "node:events";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { runProbe } from "../../src/runtime/probe/index.ts";
import { setMkfifoForTests } from "../../src/runtime/probe/named-pipes.ts";
import { runCapturedProbe } from "../../src/runtime/probe/run.ts";
import { probeShellCommand, shellQuote } from "../../src/runtime/shell.ts";
import { pidExists, pollGone } from "../helpers/process-liveness.ts";
import { tempDir } from "../helpers/tmp.ts";

afterEach(() => {
  setMkfifoForTests();
  vi.unstubAllEnvs();
});

test("C-STATS-05 a probe aborted immediately rejects before spawning", async () => {
  const controller = new AbortController();
  const reason = new Error("session closed");
  const flag = join(tempDir("elwood-canceled-probe-"), "started");
  const probe = runProbe("/bin/sh", ["-c", `echo started >${shellQuote(flag)}`], {
    signal: controller.signal,
  });
  controller.abort(reason);
  await expect(probe).rejects.toBe(reason);
  expect(existsSync(flag)).toBe(false);
});

function gatedShell(root: string) {
  const started = join(root, "started");
  const release = join(root, "release");
  const script =
    `echo "$$" >${shellQuote(started)}; ` +
    `while [ ! -f ${shellQuote(release)} ]; do /bin/sleep 0.01; done`;
  return {
    script,
    started: () =>
      vi.waitUntil(() => existsSync(started) && Number(readFileSync(started, "utf8")), {
        timeout: 10_000,
      }),
    release: () => writeFileSync(release, ""),
  };
}

test("C-STATS-05 cancellation after capture setup releases it before spawning", async () => {
  const tmp = tempDir("elwood-pre-spawn-capture-");
  vi.stubEnv("TMPDIR", tmp);
  const controller = new AbortController();
  const reason = new Error("session closed");
  let hadCapture = false;
  const probe = runProbe("/bin/sh", ["-c", probeShellCommand("echo ran")[3]], {
    signal: controller.signal,
    // The native shell check reads cwd after the capture's pipes have opened.
    get cwd() {
      hadCapture = readdirSync(tmp).length > 0;
      controller.abort(reason);
      return tmp;
    },
  });
  await expect(probe).rejects.toBe(reason);
  expect(hadCapture).toBe(true);
  expect(readdirSync(tmp)).toEqual([]);
});

test("C-STATS-05 canceling capture setup reaps the FIFO creator and removes its directory", async () => {
  const tmp = tempDir("elwood-abort-capture-");
  vi.stubEnv("TMPDIR", tmp);
  const root = tempDir("elwood-abort-mkfifo-");
  const gate = gatedShell(root);
  const helper = join(root, "mkfifo");
  writeFileSync(helper, `#!/bin/sh\n/usr/bin/mkfifo -m "$2" "$3" "$4" || exit\n${gate.script}\n`, {
    mode: 0o700,
  });
  setMkfifoForTests(helper);
  const controller = new AbortController();
  const reason = new Error("session closed");
  const probe = runProbe("/bin/sh", ["-c", probeShellCommand("echo ran")[3]], {
    signal: controller.signal,
  });
  const rejected = vi.fn();
  const settled = probe.catch(rejected);
  try {
    const pid = await gate.started();
    controller.abort(reason);
    await vi.waitFor(() => expect(rejected).toHaveBeenCalledWith(reason), { timeout: 2000 });
    expect(pidExists(pid)).toBe(false);
    expect(readdirSync(tmp)).toEqual([]);
  } finally {
    gate.release();
    await settled;
  }
});

test("C-STATS-05 canceling a running supervised probe kills its command and removes capture", async () => {
  const tmp = tempDir("elwood-running-probe-capture-");
  vi.stubEnv("TMPDIR", tmp);
  const gate = gatedShell(tempDir("elwood-running-probe-"));
  const script = probeShellCommand(`/bin/sh -c ${shellQuote(gate.script)}`)[3];
  const controller = new AbortController();
  const probe = runProbe("/bin/sh", ["-c", script], { signal: controller.signal });
  const settled = vi.fn();
  const observed = probe.then(settled);
  try {
    const pid = await gate.started();
    controller.abort();
    await vi.waitFor(
      () =>
        expect(settled).toHaveBeenCalledWith(
          expect.objectContaining({
            status: null,
            error: expect.objectContaining({ code: "ABORT_ERR" }),
          }),
        ),
      { timeout: 2500 },
    );
    expect(await pollGone({ pid, timeoutMs: 2000 })).toBe(true);
    expect(readdirSync(tmp)).toEqual([]);
    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
  } finally {
    gate.release();
    await observed;
  }
});

test("C-STATS-05 cancellation before the native error can settle a probe with no child", async () => {
  const controller = new AbortController();
  const capture = {
    args: () => [],
    watch: vi.fn(),
    ended: () => true,
    text: (): [string, string] => ["", ""],
    release: vi.fn(),
  };
  const probe = runCapturedProbe(
    "/nonexistent/elwood-canceled-probe",
    [],
    capture,
    { signal: controller.signal },
    { launch: () => 1000, command: () => 1000 },
  );
  controller.abort();
  await expect(probe).resolves.toMatchObject({ status: null, error: { code: "ABORT_ERR" } });
  expect(capture.release).toHaveBeenCalledOnce();
});
