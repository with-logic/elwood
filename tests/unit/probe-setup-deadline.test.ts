/** A stalled FIFO creator is killed and reaped before setup rejects (PRD §9.2, C-PERF-05). */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { NamedPipeCapture, setMkfifoForTests } from "../../src/runtime/probe/named-pipes.ts";
import { shellQuote } from "../../src/runtime/shell.ts";
import { killGroupsWhoseCommandHas } from "../helpers/process-liveness.ts";
import { tempDir } from "../helpers/tmp.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  setMkfifoForTests();
});

test("C-PERF-05 stalled capture setup reaps a TERM-ignoring creator and removes partial pipes", async () => {
  const root = tempDir("elwood-stalled-setup-");
  const tmp = join(root, "tmp");
  const pidFile = join(root, "pid");
  const helper = join(root, "mkfifo");
  mkdirSync(tmp);
  vi.stubEnv("TMPDIR", tmp);
  writeFileSync(
    helper,
    '#!/bin/sh\ntrap "" TERM\n/usr/bin/mkfifo -m "$2" "$3" || exit\n' +
      `printf '%s' "$$" > ${shellQuote(pidFile)}\nwhile :; do :; done\n`,
    { mode: 0o700 },
  );
  setMkfifoForTests(helper);
  let emergencyKill = false;
  // This guard only prevents a broken implementation leaking the test's own busy child.
  const safety = setTimeout(() => {
    emergencyKill = true;
    killGroupsWhoseCommandHas(helper);
  }, 3_000);
  try {
    await expect(NamedPipeCapture.create(750)).rejects.toMatchObject({
      killed: true,
      signal: "SIGKILL",
    });
    expect(emergencyKill).toBe(false);
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
    expect(readdirSync(tmp)).toEqual([]);
  } finally {
    clearTimeout(safety);
    killGroupsWhoseCommandHas(helper);
  }
});
