/** Generated child request FIN preserves delayed replies (PRD §6.2/§6.3, C-HOOK-16). */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, onTestFinished, test } from "vitest";
import { bridgeScriptSource } from "../../src/bridge/script.ts";
import { HookBridgeServer } from "../../src/bridge/server.ts";
import { tempDir } from "../helpers/tmp.ts";

test.each([
  "blocking decision",
  "handler failure",
])("C-HOOK-16 generated child waits for delayed %s after ending its request", async (outcome) => {
  const directory = tempDir("ew-fin-");
  const socketPath = join(directory, "hook.sock");
  const scriptPath = join(directory, "hook.mjs");
  const errors: string[] = [];
  let handlerFinished = false;
  let dispatched = 0;
  const completed = Promise.withResolvers<void>();
  const server = new HookBridgeServer(
    socketPath,
    "token",
    async () => {
      dispatched += 1;
      await delay(100);
      handlerFinished = true;
      completed.resolve();
      if (outcome === "handler failure") throw new Error("held handler failed");
      return { exitCode: 2, stdout: "held blocking decision", stderr: "held diagnostic" };
    },
    (error) => errors.push(`${error.category}:${error.message}`),
    () => true,
    "session",
  );
  onTestFinished(() => server.stop());
  await server.start();
  writeFileSync(scriptPath, bridgeScriptSource(socketPath, "token"));
  const child = spawn(process.execPath, [scriptPath], {
    env: { ...process.env, ELWOOD_SESSION_ID: "session" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  onTestFinished(() => {
    child.kill();
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const closed = new Promise<{ code: number | null; handlerFinished: boolean }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, handlerFinished }));
    },
  );
  child.stdin.end(JSON.stringify({ hook_event_name: "Stop", session_id: "session", cwd: "/tmp" }));
  const result = await closed;
  await completed.promise;
  expect(result.handlerFinished).toBe(true);
  expect(dispatched).toBe(1);
  if (outcome === "blocking decision") {
    expect(result.code).toBe(2);
    expect(stdout).toBe("held blocking decision");
    expect(stderr).toBe("held diagnostic");
    expect(errors).toEqual([]);
  } else {
    expect(result.code).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
    expect(errors).toEqual(["bridge_error:held handler failed"]);
  }
});
