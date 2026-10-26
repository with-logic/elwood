/**
 * A probe whose process dies of a signal reports the status a shell would, 128 + the signal's
 * number, not `null`, so a failed probe's status reads the same whether its command exited or
 * was killed (PRD §9.2, C-PERF-03). Real processes kill themselves.
 */

import { expect, test } from "vitest";
import { runProbe } from "../../src/runtime/probe/index.ts";
import { probeStartScript } from "../../src/runtime/probe/start.ts";

test.each([
  ["a direct command", "SIGTERM", "kill -TERM $$", 143],
  ["a direct command", "SIGINT", "kill -INT $$", 130],
  // The start line first: a probe script's shell, once it has started its command.
  ["a probe script's shell", "SIGTERM", `${probeStartScript}kill -TERM $$`, 143],
] as const)("C-PERF-03 %s killed by %s reports %i", async (_, _signal, script, status) => {
  const result = await runProbe("/bin/sh", ["-c", script]);
  expect(result).toEqual({ status, stdout: "", stderr: "" });
});
