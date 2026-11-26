/**
 * The harness's warmed fake executables (`tests/helpers/warm-executable.ts`, PRD §12,
 * C-E2E-23): the warm-up execs only a script that exits, never the fake's own body.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { shellQuote } from "../../src/runtime/shell.ts";
import { tempDir } from "../helpers/tmp.ts";
import { writeWarmExecutable } from "../helpers/warm-executable.ts";

test("C-E2E-23 a warmed fake holds its own body and has not run it", () => {
  const dir = tempDir("warm-executable-");
  const fake = join(dir, "fake");
  const ran = join(dir, "ran");
  const body = `#!/bin/sh\nprintf '%s\\n' "$1" >> ${shellQuote(ran)}\nexit 7\n`;
  writeWarmExecutable(fake, body);
  expect(readFileSync(fake, "utf8")).toBe(body);
  expect(statSync(fake).mode & 0o777).toBe(0o700);
  expect(existsSync(ran)).toBe(false);
  expect(spawnSync(fake, ["once"]).status).toBe(7);
  expect(readFileSync(ran, "utf8")).toBe("once\n");
});
