/**
 * Real child bridge-script fail-open behavior, exercised as a subprocess.
 * Covers PRD §6.3 (request byte cap / fail-open on overflow in the child).
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { MAX_HOOK_REQUEST_BYTES } from "../../src/bridge/limits.ts";
import { bridgeScriptSource } from "../../src/bridge/script.ts";
import { tempDirForUnit } from "./helpers.ts";

type Ran = { readonly status: number | null; readonly stdout: string; readonly stderr: string };

function runScript(stdin: string, connectible: boolean): Promise<Ran> {
  const dir = tempDirForUnit();
  const scriptPath = join(dir, "hook-bridge.mjs");
  // A socket path that no server is bound to: if the child ever reaches the
  // connect step it errors and still exits 0. The overflow guard, by contrast,
  // must exit BEFORE connecting, proving the cap short-circuits reads.
  const socketPath = connectible ? join(dir, "unbound.sock") : join(dir, "missing", "x.sock");
  writeFileSync(scriptPath, bridgeScriptSource(socketPath, "token"));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env, ELWOOD_SESSION_ID: "sess" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.on("error", reject);
    child.on("exit", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

describe("child bridge script fail-open", () => {
  test("C-HOOK-16 oversized stdin fails open (exit 0, no output) without connecting", async () => {
    const oversized = "z".repeat(MAX_HOOK_REQUEST_BYTES + 1024);
    const result = await runScript(oversized, false);
    // Exits open even though the socket dir does not exist: the read cap fires
    // before the connection is ever attempted.
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  }, 20_000);

  test("C-HOOK-16 a within-cap request connects and fails open on connect error", async () => {
    const result = await runScript(JSON.stringify({ hook_event_name: "Stop" }), true);
    // No server is listening, so the connection errors; the child still exits 0.
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  }, 20_000);

  test("C-HOOK-16 an escape-heavy input whose ENVELOPE exceeds the cap never connects", async () => {
    // Raw stdin here is UNDER the cap, but JSON.stringify doubles every backslash, so
    // the wrapped envelope exceeds 8 MiB — exactly what the server would reject. The
    // child must measure the encoded envelope (not raw stdin) and fail open BEFORE
    // connecting, so a listening server receives no connection at all.
    const dir = tempDirForUnit();
    const scriptPath = join(dir, "hook-bridge.mjs");
    const socketPath = join(dir, "srv.sock");
    let connected = false;
    const server = createServer((socket) => {
      connected = true;
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      writeFileSync(scriptPath, bridgeScriptSource(socketPath, "token"));
      // ~4.2 MiB of backslashes: raw < 8 MiB, but each escapes to "\\\\" so the JSON
      // envelope is ~8.4 MiB > the cap.
      const backslashes = "\\".repeat(Math.floor(MAX_HOOK_REQUEST_BYTES * 0.52));
      const result = await new Promise<Ran>((resolve, reject) => {
        const child = spawn(process.execPath, [scriptPath], {
          env: { ...process.env, ELWOOD_SESSION_ID: "sess" },
          stdio: ["pipe", "pipe", "pipe"],
        });
        child.on("error", reject);
        child.on("exit", (status) => resolve({ status, stdout: "", stderr: "" }));
        child.stdin.end(backslashes);
      });
      expect(result.status).toBe(0); // failed open
      expect(connected).toBe(false); // and it never opened a connection to the server
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);
});
