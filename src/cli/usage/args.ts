/** Parse repeatable profile selectors and quota display options (PRD §12A.11). */
import { parseArgs } from "node:util";
import { isOneOf } from "../../core/predicates.ts";
import { validateAccounts } from "../../core/usage/index.ts";
import type { UsageAccount } from "../../core/usage/types.ts";
import { argumentErrorMessage } from "../args/errors.ts";
import { usage } from "../request/values.ts";
import { cliAgents } from "../types.ts";

const options = {
  account: { type: "string", multiple: true },
  direction: { type: "string" },
  output: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

function accountFrom(value: string): UsageAccount {
  const match = /^([^:]+):([^=]+)(?:=(.*))?$/u.exec(value);
  if (!(match && isOneOf(match[1], cliAgents)))
    throw usage("Use --account 'agent:label=/absolute/profile' or 'agent:label'.");
  const [, agent, label, configDir] = match;
  return {
    agent,
    label: label!,
    ...(configDir === undefined ? {} : { configDir }),
  };
}

export function parseUsageArgs(args: readonly string[]) {
  try {
    const { values } = parseArgs({
      args,
      options,
    });
    const accounts = values.account?.map(accountFrom);
    if (accounts) validateAccounts(accounts);
    return { ...values, accounts };
  } catch (error) {
    throw usage(
      argumentErrorMessage(
        error,
        Object.keys(options).map((name) => `--${name}`),
      ),
    );
  }
}
