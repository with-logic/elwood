/**
 * The file's scratch sweep stops what still runs from a project root before removing it
 * (PRD §12, C-E2E-03), so a test that fails before its own cleanup leaves no process on the
 * machine. No agent is started: the leftover is a plain Node process run from the root.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { killGroupsWhoseCommandHas, processRows } from "../helpers/process-liveness.ts";
import { makeProject } from "./helpers.ts";
import { FIXTURE_LIFETIME_MS } from "./scratch-processes/fixture.ts";

const marker = `elwood-scratch-sweep-${randomUUID()}`;

// The scratch sweep registered its hook when this file imported it, so this one runs after
// the sweep: nothing the test left running from its project may have survived it.
after(() => {
  const left = processRows()
    .filter((row) => !row.stat.startsWith("Z") && row.command.includes(marker))
    .map((row) => `${row.pid} ${row.command}`);
  killGroupsWhoseCommandHas(marker);
  if (left.length > 0) throw new Error(`the scratch sweep left ${left.join("; ")}`);
});

test("C-E2E-03 the scratch sweep stops a process a test left running from its project", async () => {
  const project = makeProject("codex");
  const script = join(project.cwd, "left-running.mjs");
  writeFileSync(
    script,
    `process.send("ready"); process.disconnect(); setTimeout(() => process.exit(), ${FIXTURE_LIFETIME_MS});\n`,
  );
  // Detached and unreferenced, as an agent's daemon outlives the test that started it.
  const child = spawn(process.execPath, [script, marker], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  await once(child, "message", { signal: AbortSignal.timeout(10_000) });
  assert.ok(
    processRows().some((row) => row.pid === child.pid && row.command.includes(marker)),
    "the leftover is live before the sweep",
  );
  child.unref();
});
