/**
 * `elwood sessions`: list CLI-owned session records as a table or one JSON document
 * without launching an agent.
 * Implements PRD §12A.8 and C-CLI-22.
 */

import type { ParsedListCommand } from "../command-types.ts";
import { createCliSanitizer, formatDiagnosticValue } from "../output/sanitize.ts";
import type { AgentDetector } from "../request/agent-detect.ts";
import { resolveRunSettings } from "../request/index.ts";
import { usage } from "../request/values.ts";
import type { AsyncOutputSink } from "../stream.ts";
import { renderTable } from "../table.ts";
import type { CliEnvironment, ResolvedRunRequest } from "../types.ts";
import { type CliSessionListing, listCliSessions } from "./list.ts";

export type SessionsCommandContext = {
  readonly env: CliEnvironment;
  readonly invocationCwd: string;
  readonly homeDir: string;
  readonly stdout: AsyncOutputSink;
  readonly stderr: AsyncOutputSink;
};

export type SessionsCommandDependencies = {
  readonly list: typeof listCliSessions;
};

const defaults: SessionsCommandDependencies = { list: listCliSessions };

const header = ["ID", "AGENT", "LIVE", "RESUMABLE", "LAST USED", "CREATED", "WORKSPACE"];

/** Listing commands never select a real agent; this stands in without probing. */
const listingAgent: AgentDetector = () => Promise.resolve("claude");

export async function runSessionsCommand(
  parsed: ParsedListCommand,
  context: SessionsCommandContext,
  dependencies: SessionsCommandDependencies = defaults,
): Promise<number> {
  // `sessions` reads only `stateDir` and `output`, so it resolves with a detector
  // that never probes: listing records must not touch the login shell (C-CLI-22).
  const settings = await resolveRunSettings(parsed.run, context, listingAgent);
  assertListingOutput(settings, "sessions");
  const clean = createCliSanitizer();
  const result = dependencies.list(settings.stateDir);
  for (const skipped of result.skipped) {
    const id = formatDiagnosticValue(skipped.id, clean);
    const message = formatDiagnosticValue(skipped.message, clean);
    await context.stderr.write(`elwood: skipped session ${id}: ${message}\n`);
  }
  const sessions = result.sessions.map((session) => sanitized(session, clean));
  if (settings.output === "json") {
    const document = {
      schemaVersion: 1,
      type: "sessions",
      stateDir: clean(settings.stateDir),
      sessions,
    };
    await context.stdout.write(`${JSON.stringify(document)}\n`);
    return 0;
  }
  if (sessions.length === 0) {
    const stateDir = formatDiagnosticValue(settings.stateDir, clean);
    await context.stderr.write(`No Elwood sessions in ${stateDir}.\n`);
    return 0;
  }
  const rows = sessions.map((session) => [
    session.id,
    session.agent,
    session.live ? "yes" : "no",
    session.resumable ? "yes" : "no",
    session.lastUsedAt,
    session.createdAt,
    session.cwd,
  ]);
  await context.stdout.write(renderTable(header, rows));
  return 0;
}

/** Listings are text or JSON only; an inherited JSONL selection names its source. */
export function assertListingOutput(
  settings: ResolvedRunRequest,
  command: "sessions" | "models",
): void {
  if (settings.output !== "jsonl") return;
  const source = settings.resolution!.sources.output;
  throw usage(
    `JSONL output is selected by ${source}; ${command} supports text or JSON output. Use --output text or --output json.`,
  );
}

function sanitized(
  session: CliSessionListing,
  clean: (value: string) => string,
): CliSessionListing {
  return { ...session, id: clean(session.id), cwd: clean(session.cwd) };
}
