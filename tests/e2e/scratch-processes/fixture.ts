/**
 * Ready-signaled plain Node fixtures for scratch cleanup (PRD §12, C-E2E-03). The child
 * ignores SIGTERM and names only its unique marker, so discovery must follow its parent.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** Every scratch fixture exits by itself after this, even when cleanup fails. */
export const FIXTURE_LIFETIME_MS = 60_000;

/** Starts a parent which reports readiness only after its detached child installed its handler. */
export function spawnScratchTree(dir: string, marker: string): ChildProcess {
  const exit = `setTimeout(() => process.exit(), ${FIXTURE_LIFETIME_MS})`;
  const childScript = `process.on('SIGTERM', () => {}); process.send('ready'); process.disconnect(); ${exit}; // ${marker}`;
  writeFileSync(
    join(dir, "parent.mjs"),
    `import { spawn } from "node:child_process";
     const child = spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
     child.once('message', () => { console.log(child.pid); process.send('ready'); });
     ${exit};`,
  );
  return spawn(process.execPath, [join(dir, "parent.mjs"), marker], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore", "ipc"],
  });
}

/** Waits for fixture readiness without reading or parsing the child's PID on stdout. */
export async function scratchTreeReady(parent: ChildProcess): Promise<void> {
  await once(parent, "message", { signal: AbortSignal.timeout(10_000) });
}
