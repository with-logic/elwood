/** Session-free account quota command and per-profile output (PRD §12A.11, C-STATS-03). */
import { readUsageProfiles } from "../../core/usage/index.ts";
import type { AccountUsage } from "../../core/usage/types.ts";
import { resolveConfigPath } from "../config/paths.ts";
import { readConfig } from "../config/store.ts";
import { cliHelp } from "../help.ts";
import type { CliMainContext } from "../main.ts";
import { createCliSanitizer, formatDiagnosticValue } from "../output/sanitize.ts";
import { requiredChoice } from "../request/values.ts";
import type { AsyncOutputSink } from "../stream.ts";
import { renderTable } from "../table.ts";
import { type UsageDirection, usageDirections } from "../types.ts";
import { parseUsageArgs } from "./args.ts";

function usageRows(readings: readonly AccountUsage[], direction: UsageDirection) {
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
  const flags = parseUsageArgs(args);
  if (flags.help) {
    await stdout.write(cliHelp);
    return 0;
  }
  const config = readConfig(resolveConfigPath(context.env, context.invocationCwd, context.homeDir));
  const output = requiredChoice(
    flags.output ?? context.env["ELWOOD_OUTPUT"] ?? config.output ?? "text",
    ["text", "json"],
    "output",
  );
  const direction = requiredChoice(
    flags.direction ?? config.usageDirection ?? "left",
    usageDirections,
    "direction",
  );
  const controller = new AbortController();
  const dispose = context.signals.onSigint(() => controller.abort());
  let accounts: readonly AccountUsage[];
  try {
    accounts = await readUsageProfiles(flags.accounts, controller.signal);
  } finally {
    dispose();
  }
  if (controller.signal.aborted) return 130;
  const clean = createCliSanitizer();
  const rows = accounts.map((account) => ({
    ...account,
    label: clean(account.label),
    windows: account.windows.map((window) => ({ ...window, label: clean(window.label) })),
  }));
  await stdout.write(
    output === "json"
      ? `${JSON.stringify({ schemaVersion: 1, type: "usage", accounts: rows })}\n`
      : renderTable(
          ["AGENT", "ACCOUNT", "WINDOW", direction.toUpperCase(), "RESETS AT"],
          usageRows(accounts, direction),
        ),
  );
  return accounts.some((account) => account.status === "unavailable") ? 1 : 0;
}
