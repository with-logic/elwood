/**
 * Real-process fixture: a Node host with nothing to do but wait for one named-pipe capture,
 * whose command exits while a process it started still holds its output (C-PERF-03). Prints
 * what the capture read.
 */

import { spawn } from "node:child_process";
import { NamedPipeCapture } from "../../src/runtime/probe/named-pipes.ts";
import { probeOutputRedirect } from "../../src/runtime/probe/start.ts";

const capture = await NamedPipeCapture.create();
const script = `exec /bin/sh -c '(sleep 0.3; echo late) & echo early' ${probeOutputRedirect}`;
const child = spawn("/bin/sh", [...capture.args(["-c", script])], {
  stdio: ["ignore", "pipe", "pipe"],
});
await new Promise<void>((resolve) => capture.watch(child, { ended: resolve, overflowed: resolve }));
process.stdout.write(JSON.stringify(capture.text()));
capture.release();
