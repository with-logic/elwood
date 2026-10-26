/**
 * The exit hook of the e2e suite's default Codex home (`tests/e2e/codex-home.ts`, PRD §12,
 * C-E2E-03). When it cannot tell what still runs from the home, it keeps the home and fails
 * the run without throwing, so the `exit` listeners registered after it, which remove the
 * run's other private directories, still run. Each case loads the module in a child
 * process, the way the e2e runner does, with a user Codex home that holds no login.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { tempDir } from "../helpers/tmp.ts";

const codexHomeModule = resolve(import.meta.dirname, "../e2e/codex-home.ts");

/** Loads the module, registers a later exit hook that leaves a marker, then runs `body`. */
function exitAfter(body: string) {
  const tmp = tempDir("codex-home-exit-");
  const marker = join(tempDir("codex-home-marker-"), "later-hook-ran");
  const script = `
    import { rmSync, writeFileSync } from "node:fs";
    const { defaultCodexHome } = await import(${JSON.stringify(codexHomeModule)});
    process.on("exit", () => writeFileSync(${JSON.stringify(marker)}, ""));
    ${body}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TMPDIR: tmp,
    CODEX_HOME: tempDir("codex-home-user-"),
  };
  delete env["ELWOOD_E2E_USER_CODEX_HOME"];
  const child = spawnSync(
    process.execPath,
    ["--no-warnings", "--input-type=module", "-e", script],
    {
      env,
      encoding: "utf8",
    },
  );
  return { child, tmp, laterHookRan: existsSync(marker) };
}

test("C-E2E-03 an exit removes the default Codex home and runs the exit hooks after it", () => {
  const { child, tmp, laterHookRan } = exitAfter("");
  expect(child.stderr).toBe("");
  expect(child.status).toBe(0);
  expect(laterHookRan).toBe(true);
  expect(readdirSync(tmp)).toEqual([]);
});

test("C-E2E-03 a Codex home the exit cannot check fails the run, and later exit hooks still run", () => {
  // Gone from under the hook, the home's processes cannot be looked up (`realpath` fails).
  const { child, laterHookRan } = exitAfter("rmSync(defaultCodexHome, { recursive: true });");
  expect(child.stderr).toMatch(/^Kept the e2e Codex home \S+elwood_e2e_codex_home-\S+: ENOENT/m);
  expect(child.status).toBe(1);
  expect(laterHookRan).toBe(true);
});
