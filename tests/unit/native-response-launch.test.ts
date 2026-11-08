/** Native response proofs accept only the production launch preamble (C-E2E-17). */
import { afterEach, expect, test, vi } from "vitest";
import { buildCodexShellCommand } from "../../src/codex/command.ts";
import { reportCodexHomeCommand, reportFailedStatus } from "../../src/codex/config/home.ts";
import { loginShellCommand } from "../../src/runtime/shell.ts";
import { createSessionRecord } from "../../src/state/store.ts";
import { parseResponseLaunchCommand, pinResponseLaunchCommand } from "../e2e/response/launch.ts";

afterEach(() => vi.unstubAllEnvs());
const variants = [
  { guarded: false, resumed: false },
  { guarded: false, resumed: true },
  { guarded: true, resumed: false },
  { guarded: true, resumed: true },
];
type LaunchCase = {
  readonly guarded: boolean;
  readonly resumed: boolean;
  readonly reportPath?: string;
};

function commandFor({
  guarded,
  resumed,
  reportPath = "/tmp/elwood-response-socket/codex-home-proof",
}: LaunchCase) {
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
  const report = reportCodexHomeCommand(reportPath);
  const command = loginShellCommand(`${report}; ${launch}`).at(-1)!;
  return { command, launch };
}

test.each(
  variants,
)("C-E2E-17 retains exact launch and preamble for $guarded/$resumed", (variant) => {
  const { command, launch } = commandFor(variant);
  const parsed = parseResponseLaunchCommand(command);
  expect(parsed.launch).toBe(launch);
  expect(`${parsed.prefix}${parsed.launch}`).toBe(command);
});

test.each(variants)("C-E2E-17 accepts a quoted report path for $guarded/$resumed", (variant) => {
  const { command, launch } = commandFor({
    ...variant,
    reportPath: "/tmp/elwood's-response-socket/codex-home-proof",
  });
  expect(parseResponseLaunchCommand(command).launch).toBe(launch);
});

test.each(
  variants,
)("C-E2E-17 pins only the exec model and preserves the preamble for $guarded/$resumed", (variant) => {
  const { command, launch } = commandFor(variant);
  const prefix = command.slice(0, -launch.length);
  const pinned = pinResponseLaunchCommand(command, {
    resumed: variant.resumed,
    model: "gpt-6-luna",
  });
  expect(pinned).toBe(`${prefix}${launch}${variant.resumed ? " --model 'gpt-6-luna'" : ""}`);
  expect(parseResponseLaunchCommand(pinned).prefix).toBe(prefix);
});

test("C-E2E-17 an unpinned initial model is still refused", () => {
  const { command } = commandFor({ guarded: true, resumed: false });
  expect(() =>
    pinResponseLaunchCommand(command.replace("--model 'gpt-6-luna'", ""), {
      resumed: false,
      model: "gpt-6-luna",
    }),
  ).toThrow("Missing pinned model");
});

const rejected: readonly {
  readonly name: string;
  readonly alter: (command: string) => string | undefined;
}[] = [
  { name: "missing command", alter: () => undefined },
  { name: "unprefixed exec", alter: () => "exec codex --model 'gpt-6-luna'" },
  { name: "unexpected prelude", alter: (command) => `echo unexpected; ${command}` },
  {
    name: "changed failure status",
    alter: (command) =>
      command.replace(`|| exit ${reportFailedStatus}`, `|| exit ${reportFailedStatus + 1}`),
  },
  {
    name: "different executable",
    alter: (command) => command.replace("; exec codex ", "; exec other "),
  },
];

test.each(
  variants.flatMap((variant) => rejected.map((item) => ({ ...variant, ...item }))),
)("C-E2E-17 rejects $name for $guarded/$resumed", ({ guarded, resumed, alter }) => {
  const { command } = commandFor({ guarded, resumed });
  expect(() => parseResponseLaunchCommand(alter(command))).toThrow("Unexpected native command");
});
