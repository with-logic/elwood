/** Session-free account quota command and per-profile output (PRD §12A.11, C-STATS-03). */
import { parseArgs } from "node:util";
import { readAccountUsage, validateAccounts } from "../../core/usage/index.ts";
import type { AccountUsage, UsageAccount } from "../../core/usage/types.ts";
import { resolveConfigPath } from "../config/paths.ts";
import { readConfig } from "../config/store.ts";
import type { CliMainContext } from "../main.ts";
import { formatDiagnosticValue } from "../output/sanitize.ts";
import { requiredChoice, usage } from "../request/values.ts";
import type { AsyncOutputSink } from "../stream.ts";
import { renderTable } from "../table.ts";

function accountFrom(value: string): UsageAccount {
  const match = /^(claude|codex):([^=]+)(?:=(.*))?$/u.exec(value);
  if (!match) throw usage("Use --account 'agent:label=/absolute/profile' or 'agent:label'.");
  const [, agent, label, configDir] = match;
  return {
    agent: agent as UsageAccount["agent"],
    label: label!,
    ...(configDir === undefined ? {} : { configDir }),
  };
}

function parse(args: readonly string[]) {
  try {
    const { values } = parseArgs({
      args,
      options: {
        account: { type: "string", multiple: true },
        direction: { type: "string" },
        output: { type: "string" },
      },
    });
    const accounts = values.account?.map(accountFrom);
    if (accounts) validateAccounts(accounts);
    return { ...values, accounts };
  } catch (error) {
    throw usage((error as Error).message);
  }
}

function usageRows(readings: readonly AccountUsage[], direction: "used" | "left") {
  return readings.flatMap((reading) => {
    const account = [reading.agent, formatDiagnosticValue(reading.label)];
    if (reading.status === "unavailable") return [[...account, "Unavailable", "—", "—"]];
    return reading.windows.map((window) => {
      const percent = direction === "used" ? window.usedPercent : window.remainingPercent;
      return [
        ...account,
        formatDiagnosticValue(window.label),
        `${Number(percent.toFixed(2))}%`,
        window.resetsAt ?? "—",
      ];
    });
  });
}

export async function runUsageCommand(
  args: readonly string[],
  context: CliMainContext,
  stdout: AsyncOutputSink,
): Promise<number> {
  const flags = parse(args);
  const config = readConfig(resolveConfigPath(context.env, context.invocationCwd, context.homeDir));
  const output = requiredChoice(
    flags.output ?? context.env["ELWOOD_OUTPUT"] ?? config.output ?? "text",
    ["text", "json"],
    "output",
  );
  const direction = requiredChoice(
    flags.direction ?? config.usageDirection ?? "left",
    ["left", "used"] as const,
    "direction",
  );
  let interrupted = false;
  const dispose = context.signals.onSigint(() => {
    interrupted = true;
  });
  try {
    const accounts = await readAccountUsage(flags.accounts);
    if (interrupted) return 130;
    await stdout.write(
      output === "json"
        ? `${JSON.stringify({ schemaVersion: 1, type: "usage", accounts })}\n`
        : renderTable(
            ["AGENT", "ACCOUNT", "WINDOW", direction.toUpperCase(), "RESETS AT"],
            usageRows(accounts, direction),
          ),
    );
    return accounts.some((account) => account.status === "unavailable") ? 1 : 0;
  } finally {
    dispose();
  }
}
