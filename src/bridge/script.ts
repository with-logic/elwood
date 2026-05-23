/**
 * Generates the standalone hook bridge script invoked by Claude hooks.
 * Implements PRD §6.2.
 */

export function bridgeScriptSource(socketPath: string, token: string): string {
  return `import net from "node:net";

const socketPath = ${JSON.stringify(socketPath)};
const token = ${JSON.stringify(token)};

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

const inputText = await readStdin();
const client = net.createConnection({ path: socketPath });
let response = "";

client.on("data", (chunk) => {
  response += chunk.toString("utf8");
});

client.on("error", () => {
  process.exit(0);
});

client.on("connect", () => {
  client.write(JSON.stringify({ token, input: inputText }));
});

client.on("end", () => {
  try {
    const parsed = JSON.parse(response || "{}");
    if (parsed.stdout) process.stdout.write(parsed.stdout);
    if (parsed.stderr) process.stderr.write(parsed.stderr);
    process.exit(typeof parsed.exitCode === "number" ? parsed.exitCode : 0);
  } catch {
    process.exit(0);
  }
});
`;
}
