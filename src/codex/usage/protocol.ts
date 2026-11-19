/** Codex app-server initialization and account quota request (PRD §5.12). */
export const codexUsageProtocol = {
  variable: "CODEX_HOME",
  protocol: `
if (profileDir !== undefined && process.env.CODEX_HOME !== profileDir) process.exit(1);
const args = ["app-server", "--listen", "stdio://"];
const initial = { id: 1, method: "initialize", params: { clientInfo: { name: "elwood", version: "1" } } };
function receive(message) {
  if (message?.id === 1) {
    if (!message.result) return null;
    send({ method: "initialized" });
    send({ id: 2, method: "account/rateLimits/read", params: {} });
  }
  return message?.id === 2 ? message.result ?? null : undefined;
}
`,
} as const;
