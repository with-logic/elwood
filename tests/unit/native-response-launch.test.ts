/** Native response proofs accept only the production launch preamble (C-E2E-17). */
import { afterEach, expect, test, vi } from "vitest";
import { buildCodexShellCommand } from "../../src/codex/command.ts";
import { reportCodexHomeCommand } from "../../src/codex/config/home.ts";
import { loginShellCommand } from "../../src/runtime/shell.ts";
import { createSessionRecord } from "../../src/state/store.ts";
import { responseLaunch } from "../e2e/response/launch.ts";

afterEach(() => vi.unstubAllEnvs());
const variants = [
  { guarded: false, resumed: false },
  { guarded: false, resumed: true },
  { guarded: true, resumed: false },
  { guarded: true, resumed: true },
];

function commandFor(guarded: boolean, resumed: boolean) {
  const home = "/tmp/elwood-response-home";
  vi.stubEnv("CODEX_HOME", home);
  vi.stubEnv("ELWOOD_E2E_PRIVATE_HOMES", guarded ? JSON.stringify([home]) : "");
  const record = createSessionRecord({
    cwd: "/tmp/elwood-response-project",
    id: "proof",
    adapter: "codex",
  });
  const launch = buildCodexShellCommand(
    resumed ? { ...record, codex: { resumeId: "proof-resume" } } : record,
    "/tmp/elwood-response-project/hook-bridge.mjs",
    { cwd: record.cwd, model: "gpt-6-luna", sandbox: "read-only", approvalPolicy: "never" },
  );
  const report = reportCodexHomeCommand("/tmp/elwood-response-socket/codex-home-proof");
  const command = loginShellCommand(`${report}; ${launch}`).at(-1)!;
  return { command, launch };
}

test.each(variants)("C-E2E-17 retains exact launch and preamble for $guarded/$resumed", ({
  guarded,
  resumed,
}) => {
  const { command, launch } = commandFor(guarded, resumed);
  const parsed = responseLaunch(command);
  expect(parsed.launch).toBe(launch);
  expect(`${parsed.prefix}${parsed.launch}`).toBe(command);
});

test.each(variants)("C-E2E-17 rejects unrelated or altered launches for $guarded/$resumed", ({
  guarded,
  resumed,
}) => {
  const { command } = commandFor(guarded, resumed);
  for (const invalid of [
    undefined,
    "exec codex --model 'gpt-6-luna'",
    `echo unexpected; ${command}`,
    command.replace("|| exit 73", "|| exit 0"),
    command.replace("; exec codex ", "; exec other "),
  ]) {
    expect(() => responseLaunch(invalid)).toThrow("Unexpected native command");
  }
});
