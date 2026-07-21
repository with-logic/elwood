/**
 * Generates the standalone hook bridge script invoked by Claude hooks.
 * Implements PRD §6.2 and §6.3 (request byte cap / fail-open on overflow).
 */

import { MAX_HOOK_REQUEST_BYTES } from "./limits.ts";

export function bridgeScriptSource(socketPath: string, token: string): string {
  return `import net from "node:net";

const socketPath = ${JSON.stringify(socketPath)};
const token = ${JSON.stringify(token)};
const maxRequestBytes = ${MAX_HOOK_REQUEST_BYTES};
const elwoodSessionId = process.env.ELWOOD_SESSION_ID ?? "";

// Cap raw stdin bytes: a hook payload carries arbitrary tool output, so read no
// more than the shared ceiling and fail open (empty decision, exit 0) the moment
// the envelope would exceed it (PRD §6.3).
async function readStdin() {
  let data = "";
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > maxRequestBytes) process.exit(0);
    data += chunk;
  }
  return data;
}

const inputText = await readStdin();
const client = net.createConnection({ path: socketPath });
let response = "";
let finished = false;

function finish() {
  if (finished) return;
  try {
    const parsed = JSON.parse(response || "{}");
    finished = true;
    if (parsed.stdout) process.stdout.write(parsed.stdout);
    if (parsed.stderr) process.stderr.write(parsed.stderr);
    process.exit(typeof parsed.exitCode === "number" ? parsed.exitCode : 0);
  } catch {}
}

client.on("data", (chunk) => {
  response += chunk.toString("utf8");
  finish();
});

client.on("error", () => {
  process.exit(0);
});

client.on("connect", () => {
  client.end(JSON.stringify({ token, elwoodSessionId, input: inputText }) + "\\n");
});

client.on("end", finish);
client.on("close", finish);
`;
}
