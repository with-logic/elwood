/** Bounded native quota protocol for the supervised login-shell probe (PRD §5.12). */

import { maxProbeStreamOutputBytes } from "../../runtime/probe/capped-buffer.ts";
import { currentCommandRunner } from "../../runtime/seams.ts";
import { probeShellCommand, userShell } from "../../runtime/shell.ts";
import { shellQuote } from "../shell.ts";
import type { UsageAccount } from "./types.ts";

// This small stdio client runs inside the existing supervised probe process group.
// Embedders can bundle Elwood without locating or copying a helper executable.
const quotaClient = `
const { spawn } = require("node:child_process");
const agent = process.argv[1];
const claude = agent === "claude";
const profileDir = process.argv[2];
if (profileDir !== undefined && process.env[claude ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"] !== profileDir) process.exit(1);
const args = claude
  ? ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
     "--no-session-persistence", "--strict-mcp-config", "--setting-sources", "user",
     "--settings", '{"disableAllHooks":true}', "--tools", ""]
  : ["app-server", "--listen", "stdio://"];
const child = spawn(agent, args, { stdio: ["pipe", "pipe", "ignore"] });
process.exitCode = 1;
child.on("error", () => {});
child.stdin.on("error", () => {});
function send(message) {
  child.stdin.write(JSON.stringify(message) + "\\n");
}
if (claude) {
  send({ type: "control_request", request_id: "usage", request: { subtype: "get_usage", skip_behaviors: true } });
} else {
  send({ id: 1, method: "initialize", params: { clientInfo: { name: "elwood", version: "1" } } });
}
let pending = "";
let bytes = 0;
let done = false;
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  if (done) return;
  bytes += Buffer.byteLength(chunk);
  if (bytes > ${maxProbeStreamOutputBytes}) {
    done = true;
    child.kill("SIGKILL");
    return;
  }
  const lines = (pending + chunk).split("\\n");
  pending = lines.pop();
  for (const line of lines) {
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (!claude && message?.id === 1) {
      if (!message.result) { done = true; child.stdin.end(); return; }
      send({ method: "initialized" });
      send({ id: 2, method: "account/rateLimits/read", params: {} });
    } else if (claude
      ? message?.type === "control_response" && message.response?.request_id === "usage"
      : message?.id === 2) {
      const result = claude ? message.response.subtype === "success" && message.response.response : message.result;
      if (result && typeof result === "object") {
        process.stdout.write(JSON.stringify(result));
        process.exitCode = 0;
      }
      done = true;
      child.stdin.end();
      return;
    }
  }
});
`;

export async function probeQuota(account: UsageAccount): Promise<unknown> {
  const variable = account.agent === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
  const args = [
    "/usr/bin/env",
    "ELECTRON_RUN_AS_NODE=1",
    process.execPath,
    "--input-type=commonjs",
    "-e",
    quotaClient,
    account.agent,
  ];
  if (account.configDir !== undefined) args.push(account.configDir);
  const command = args.map(shellQuote).join(" ");
  const result = await currentCommandRunner()(
    userShell(),
    probeShellCommand(command, account.agent),
    {
      cwd: "/",
      env:
        account.configDir === undefined
          ? process.env
          : { ...process.env, [variable]: account.configDir },
    },
  );
  if (result.status !== 0 || result.error) return undefined;
  return JSON.parse(result.stdout) as unknown;
}
