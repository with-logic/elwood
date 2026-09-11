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

// Read stdin under an OOM guard: a hook payload carries arbitrary tool output, so
// stop buffering once even the RAW input alone already exceeds the ceiling — the
// JSON-wrapped envelope can only be larger, so it could never pass the real cap.
async function readStdin() {
  // Collect RAW bytes and decode ONCE after EOF: \`data += chunk\` would decode each
  // chunk on its own and insert replacement chars whenever a multibyte code point
  // straddles two chunks, corrupting the hook payload (PRD §6.2).
  const parts = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > maxRequestBytes) process.exit(0);
    parts.push(chunk);
  }
  return Buffer.concat(parts).toString("utf8");
}

const inputText = await readStdin();
// The cap the SERVER enforces is on the encoded wire envelope, not raw stdin. Build
// the exact envelope here and fail open (empty decision, exit 0) if IT exceeds the
// ceiling, so an escape-heavy input the server would reject is not sent (PRD §6.3):
// the child and server now measure the identical bytes, not stdin vs. wrapped JSON.
const request = JSON.stringify({ token, elwoodSessionId, input: inputText }) + "\\n";
if (Buffer.byteLength(request, "utf8") > maxRequestBytes) process.exit(0);
const client = net.createConnection({ path: socketPath });
let response = "";
let finished = false;

function finish() {
  if (finished) return;
  try {
    const parsed = JSON.parse(response || "{}");
    finished = true;
    // Set the exit code and let the event loop drain rather than calling
    // process.exit() synchronously: pipe writes are asynchronous on macOS, so a
    // synchronous exit could truncate a decision larger than the pipe buffer
    // (~64 KiB) before Claude read it. Destroying the socket releases the last
    // handle, so the process exits on its own once stdout/stderr have flushed.
    process.exitCode = typeof parsed.exitCode === "number" ? parsed.exitCode : 0;
    if (parsed.stdout) process.stdout.write(parsed.stdout);
    if (parsed.stderr) process.stderr.write(parsed.stderr);
    client.destroy();
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
  client.end(request);
});

client.on("end", finish);
client.on("close", finish);
`;
}
