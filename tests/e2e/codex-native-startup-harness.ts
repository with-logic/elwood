/** Real Codex PTY with an isolated config for startup-layout checks (PRD §12, C-E2E-09). */
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node-pty";
import { probeShellCommand, userShell } from "../../src/runtime/shell.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";
import { makeProject, sandboxedCodexHome, waitFor } from "./helpers.ts";

/** Local authentication failure creates Codex's own MCP warning without an external service. */
export async function unauthenticatedMcp() {
  const server = createServer((_request, response) => {
    response.writeHead(401, { "WWW-Authenticate": "Bearer", "Content-Type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing MCP port");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    },
  };
}

/** Omit hook-trust bypass deliberately: this test must see both native trust gates. */
export function nativeCodex(mcpUrl: string) {
  const project = makeProject("codex");
  const sandbox = sandboxedCodexHome(
    project,
    `check_for_update_on_startup = false
[features]
hooks = true
[hooks]
SessionStart = [{matcher="startup",hooks=[{type="command",command="true"}]}]
[mcp_servers.elwood_probe]
url = "${mcpUrl}"
startup_timeout_sec = 2
`,
  );
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(
      userShell(),
      [
        ...probeShellCommand(
          "exec codex --no-alt-screen --sandbox read-only --ask-for-approval never",
        ),
      ],
      {
        cwd: project.cwd,
        env: { ...process.env, TERM: "xterm-256color" },
        cols: 100,
        rows: 40,
        name: "xterm-256color",
      },
    );
  } catch (error) {
    sandbox.dispose();
    throw error;
  }
  const terminal = createHeadlessTerminal({ cols: 100, rows: 40 }, (input) =>
    child.write(typeof input === "string" ? input : Buffer.from(input)),
  );
  const data = child.onData((output) => void terminal.writeOutput(output));
  let exited = false;
  child.onExit(() => {
    exited = true;
  });
  return {
    terminal,
    frame: () => terminal.snapshot().text,
    close: async () => {
      try {
        if (!exited) {
          child.write("\u0003");
          await delay(100);
          if (!exited) child.write("\u0003");
          await delay(500);
          if (!exited) child.kill("SIGKILL");
          await waitFor(() => (exited ? true : undefined), "native Codex exit", 5_000);
        }
      } finally {
        data.dispose();
        try {
          await terminal.settled();
        } finally {
          terminal.dispose();
          sandbox.dispose();
        }
      }
    },
  };
}
