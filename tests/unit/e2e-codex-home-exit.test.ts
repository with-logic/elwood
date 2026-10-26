/**
 * The exit hook of the e2e suite's default Codex home (`tests/e2e/codex-home.ts`, PRD §12,
 * C-E2E-03). When it cannot tell what still runs from the home, it keeps the home and fails
 * the run without throwing, so the `exit` listeners registered after it, which remove the
 * run's other private directories, still run. Each case loads the module in a child
 * process, the way the e2e runner does, with a user Codex home that holds no login.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { tempDir } from "../helpers/tmp.ts";

const codexHomeModule = resolve(import.meta.dirname, "../e2e/codex-home.ts");

/**
 * Loads the module with its temp dir in `tmp`, registers a later exit hook that leaves a
 * marker, then runs `body`. Reports the home the child made.
 */
function exitAfter(tmp: string, body = "") {
  const marker = join(tempDir("codex-home-marker-"), "later-hook-ran");
  const script = `
    import { chmodSync, writeFileSync } from "node:fs";
    import { dirname } from "node:path";
    const { defaultCodexHome } = await import(${JSON.stringify(codexHomeModule)});
    console.log(defaultCodexHome);
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
    { env, encoding: "utf8" },
  );
  return { child, home: child.stdout.trim(), laterHookRan: existsSync(marker) };
}

test("C-E2E-03 an exit removes the default Codex home and runs the exit hooks after it", () => {
  const tmp = tempDir("codex-home-exit-");
  const { child, laterHookRan } = exitAfter(tmp);
  expect(child.stderr).toBe("");
  expect(child.status).toBe(0);
  expect(laterHookRan).toBe(true);
  expect(readdirSync(tmp)).toEqual([]);
});

test("C-E2E-03 a Codex home the exit cannot check is kept, fails the run, and later exit hooks still run", () => {
  const tmp = tempDir("codex-home-exit-");
  try {
    // Without search permission on its parent, the home's real path cannot be read, so
    // nothing can tell what runs from it.
    const { child, home, laterHookRan } = exitAfter(
      tmp,
      "chmodSync(dirname(defaultCodexHome), 0o600);",
    );
    expect(child.stderr).toMatch(/^Could not clean up the e2e Codex home \S+: EACCES/m);
    expect(child.status).toBe(1);
    expect(laterHookRan).toBe(true);
    chmodSync(tmp, 0o700);
    expect(home.startsWith(join(tmp, "elwood_e2e_codex_home-"))).toBe(true);
    expect(readdirSync(tmp)).toEqual([home.slice(tmp.length + 1)]);
  } finally {
    chmodSync(tmp, 0o700);
  }
});
