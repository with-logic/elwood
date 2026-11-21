/** Bounded native quota protocol for the supervised login-shell probe (PRD §5.12). */

import { readClaudeFallback } from "../../claude/usage/fallback.ts";
import { claudeUsageProtocol } from "../../claude/usage/protocol.ts";
import { claudeWindows } from "../../claude/usage/windows.ts";
import { codexUsageProtocol } from "../../codex/usage/protocol.ts";
import { codexAppServerWindows } from "../../codex/usage/windows.ts";
import { maxProbeStreamOutputBytes } from "../../runtime/probe/capped-buffer.ts";
import { currentCommandRunner } from "../../runtime/seams.ts";
import { probeShellCommand, userShell } from "../../runtime/shell.ts";
import { shellQuote } from "../shell.ts";
import type { UsageAccount, UsageWindow } from "./types.ts";

const fallbackMarker = "ELWOOD_QUOTA_FALLBACK\n";

// This small stdio client runs inside the existing supervised probe process group.
// Embedders can bundle Elwood without locating or copying a helper executable.
function quotaClient(protocol: string) {
  return `
const { spawn } = require("node:child_process");
const agent = process.argv[1];
const profileDir = process.argv[2];
${protocol}
const child = spawn(agent, args, { stdio: ["pipe", "pipe", "ignore"] });
process.exitCode = 1;
child.on("error", () => {});
child.stdin.on("error", () => {});
function send(message) {
  child.stdin.write(JSON.stringify(message) + "\\n");
}
function relayFallback(args) {
  process.stdout.write(${JSON.stringify(fallbackMarker)});
  const fallback = spawn(agent, args, {
    stdio: ["ignore", "pipe", "ignore"]
  });
  fallback.on("error", () => {});
  fallback.stdout.pipe(process.stdout, { end: false });
  fallback.once("close", (status) => { if (status === 0) process.exitCode = 0; });
}
send(initial);
let pending = "";
let bytes = 0;
let done = false;
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  if (done) return;
  bytes += Buffer.byteLength(chunk);
  if (bytes > ${maxProbeStreamOutputBytes}) {
    done = true;
    // Trip the supervisor's output bound. It owns cleanup of the entire process group.
    process.stderr.write(Buffer.alloc(${maxProbeStreamOutputBytes} + 1));
    return;
  }
  const lines = (pending + chunk).split("\\n");
  pending = lines.pop();
  for (const line of lines) {
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    const result = receive(message);
    if (result === undefined) continue;
    if (typeof result === "function") child.once("close", result);
    else if (result && typeof result === "object") {
      process.stdout.write(JSON.stringify(result));
      process.exitCode = 0;
    }
    done = true;
    child.stdin.end();
    return;
  }
});
`;
}

export async function probeQuota(
  account: UsageAccount,
  signal?: AbortSignal,
): Promise<readonly UsageWindow[]> {
  const { variable, protocol } =
    account.agent === "claude" ? claudeUsageProtocol : codexUsageProtocol;
  const args = [
    "/usr/bin/env",
    "ELECTRON_RUN_AS_NODE=1",
    process.execPath,
    "--input-type=commonjs",
    "-e",
    quotaClient(protocol),
    account.agent,
  ];
  if (account.configDir !== undefined) args.push(account.configDir);
  const command = args.map(shellQuote).join(" ");
  const result = await currentCommandRunner()(
    userShell(),
    probeShellCommand(command, account.agent),
    {
      cwd: "/",
      signal,
      env:
        account.configDir === undefined
          ? process.env
          : { ...process.env, [variable]: account.configDir },
    },
  );
  if (result.error?.code === "ABORT_ERR") return [];
  const failed = result.status !== 0 || result.error !== undefined;
  if (account.agent === "claude" && result.stdout.startsWith(fallbackMarker)) {
    return readClaudeFallback(failed ? undefined : result.stdout.slice(fallbackMarker.length));
  }
  if (failed) return [];
  const native: unknown = JSON.parse(result.stdout);
  return account.agent === "claude" ? claudeWindows(native) : codexAppServerWindows(native);
}
