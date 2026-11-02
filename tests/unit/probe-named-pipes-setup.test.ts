/**
 * A named-pipe capture's setup and release: one that cannot make its directory or its pipes, or
 * that fails after opening its first pipe, rejects and leaves nothing behind, and one released
 * twice is released once (PRD §9.2, C-PERF-05). Each test points TMPDIR at a directory of its
 * own and checks that the capture left it empty.
 */

import { chmodSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { NamedPipeCapture, setMkfifoForTests } from "../../src/runtime/probe/named-pipes.ts";
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

test("C-PERF-05 a capture released twice is released once", async () => {
  const tmp = privateTmp();
  const capture = await NamedPipeCapture.create();
  capture.release();
  capture.release();
  await vi.waitFor(() => expect(readdirSync(tmp)).toEqual([]));
});

test.each([
  ["its directory", () => vi.stubEnv("TMPDIR", "/nonexistent/elwood-tmp"), "ENOENT"],
  ["its named pipes", () => setMkfifoForTests("/nonexistent/elwood-mkfifo"), "ENOENT"],
  // `mkfifo` ran and failed: its exit status is no errno.
  ["its named pipes, mkfifo failing", () => setMkfifoForTests("/usr/bin/false"), 1],
])("C-PERF-05 a capture that cannot make %s fails and leaves nothing", async (_, breakIt, code) => {
  const tmp = privateTmp();
  breakIt();
  await expect(NamedPipeCapture.create()).rejects.toMatchObject({ code });
  expect(readdirSync(tmp)).toEqual([]);
});

test("C-PERF-05 a capture that fails after opening its first pipe closes it, and leaves nothing", async () => {
  const tmp = privateTmp();
  // A `mkfifo` that makes only the first of the pipes it is asked for, so the second's open fails.
  const fake = join(tempDir("elwood-capture-mkfifo-"), "mkfifo");
  writeFileSync(fake, '#!/bin/sh\nexec /usr/bin/mkfifo -m "$2" "$3"\n');
  chmodSync(fake, 0o755);
  setMkfifoForTests(fake);
  await expect(NamedPipeCapture.create()).rejects.toMatchObject({ code: "ENOENT" });
  expect(readdirSync(tmp)).toEqual([]);
});
