/** Node subprocess fixtures with bounded failure diagnostics (PRD §9.2, C-PERF-04). */
import { spawn } from "node:child_process";

// Retain only the final 4096 UTF-16 code units of child failure diagnostics.
const maxStderrCodeUnits = 4_096;

/** Launch a fixture script; callers retain ownership of cancellation and exit assertions. */
export function startNodeScript(script: string, environment: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], {
    env: { ...process.env, ...environment },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (data: Buffer) => {
    stderr = (stderr + data.toString()).slice(-maxStderrCodeUnits);
  });
  const exit = new Promise<{ readonly status: number | null; readonly stderr: string }>(
    (resolve) => {
      child.on("close", (status) => resolve({ status, stderr }));
    },
  );
  return { process: child, exit };
}
