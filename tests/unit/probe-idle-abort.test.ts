/** Abort cleanup delivers its result on an otherwise idle host (PRD §9.2, C-PERF-03). */
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { shellQuote } from "../../src/runtime/shell.ts";
import { killGroupsWhoseCommandHas } from "../helpers/process-liveness.ts";
import { tempDir } from "../helpers/tmp.ts";

test("C-PERF-03 abort retains an idle host through a refused first signal", async () => {
  const root = tempDir("elwood-idle-abort-");
  const writer = join(root, "owned-loop");
  writeFileSync(writer, "#!/bin/sh\nwhile :; do /bin/sleep 1; done\n", { mode: 0o700 });
  const fixture = join(root, "host.mjs");
  const runtime = new URL("../../src/runtime/probe/index.ts", import.meta.url).href;
  const shell = new URL("../../src/runtime/shell.ts", import.meta.url).href;
  writeFileSync(
    fixture,
    `
import {runProbe,setProbeTimeoutsForTests} from ${JSON.stringify(runtime)};
import {probeShellCommand} from ${JSON.stringify(shell)};
const kill = process.kill.bind(process); let refused = false;
process.kill = (pid,signal) => {
  if (signal === "SIGKILL" && !refused) { refused = true; throw Object.assign(new Error("refused"),{code:"EPERM"}); }
  return kill(pid,signal);
};
setProbeTimeoutsForTests({commandMs:150,launchMs:10000});
console.log(JSON.stringify(await runProbe('/bin/sh',['-c',probeShellCommand(${JSON.stringify(shellQuote(writer))})[3]])));
`,
  );
  try {
    const result = await promisify(execFile)(process.execPath, ["--no-warnings", fixture], {
      timeout: 10_000,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ error: { code: "ETIMEDOUT" } });
  } finally {
    killGroupsWhoseCommandHas(root);
  }
});
