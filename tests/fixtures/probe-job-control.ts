/** Real-process probe fixture for preserving the caller PTY foreground group (C-CLI-18). */

import { execFileSync } from "node:child_process";
import { runProbe } from "../../src/runtime/probe.ts";

await runProbe("/bin/zsh", ["-f", "-i", "-c", "/bin/sleep 0.05"]);

const status = execFileSync("/bin/ps", ["-o", "pgid=,tpgid=", "-p", String(process.pid)], {
  encoding: "utf8",
}).trim();
const [processGroup, foregroundGroup] = status.split(/\s+/);
const preserved = processGroup !== undefined && processGroup === foregroundGroup;
process.stdout.write(`ELWOOD_PROBE_FOREGROUND=${String(preserved)}\n`);
process.exitCode = preserved ? 0 : 1;
