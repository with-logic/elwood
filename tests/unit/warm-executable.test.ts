/**
 * The harness's warmed fake executables (`tests/helpers/warm-executable.ts`, PRD §12,
 * C-E2E-23): the warm-up execs, under a bound, only a script that exits, never the fake's
 * own body.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { shellQuote } from "../../src/runtime/shell.ts";
import { tempDir } from "../helpers/tmp.ts";
import { type WarmUpRun, warmUpBoundMs, writeWarmExecutable } from "../helpers/warm-executable.ts";

test("C-E2E-23 a warmed fake holds its own body and has not run it", () => {
  const dir = tempDir("warm-executable-");
  const fake = join(dir, "fake");
  const ran = join(dir, "ran");
  const body = `#!/bin/sh\nprintf '%s\\n' "$1" >> ${shellQuote(ran)}\nexit 7\n`;
  // What the warm-up exec found at `fake`, and how it was run.
  const warmUps: { text: string; mode: number; timeout: unknown; status: number | null }[] = [];
  const recorded: WarmUpRun = (path, options) => {
    const run = spawnSync(path, [], options);
    warmUps.push({
      text: readFileSync(path, "utf8"),
      mode: statSync(path).mode & 0o777,
      timeout: options.timeout,
      status: run.status,
    });
  };
  writeWarmExecutable(fake, body, recorded);
  expect(warmUps).toEqual([
    { text: "#!/bin/sh\nexit 0\n", mode: 0o700, timeout: warmUpBoundMs, status: 0 },
  ]);
  expect(readFileSync(fake, "utf8")).toBe(body);
  expect(statSync(fake).mode & 0o777).toBe(0o700);
  expect(existsSync(ran)).toBe(false);
  expect(spawnSync(fake, ["once"]).status).toBe(7);
  expect(readFileSync(ran, "utf8")).toBe("once\n");
});
