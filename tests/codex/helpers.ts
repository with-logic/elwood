import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetCodexPreflightCacheForTests } from "../../src/codex/preflight.ts";
import { resetCodexSessionSeamsForTests } from "../../src/codex/session.ts";
import type { TerminalSize } from "../../src/index.ts";
import type { PtyExit, PtyProcess, PtySpawnOptions } from "../../src/pty/types.ts";
import {
  resetRuntimeSeamsForTests,
  setCommandRunnerForTests,
  setPlatformForTests,
  setPtyFactoryForTests,
} from "../../src/runtime/seams.ts";
import { resetStartupWaitMsForTests, setStartupWaitMsForTests } from "../../src/runtime/startup.ts";
import { resetPreflightCacheForTests } from "../../src/runtime/update-once.ts";

export const ptys: FakePty[] = [];

const versionOk =
  (supportsHookTrustBypass: boolean) => (_command: string, args: readonly string[]) =>
    args.join(" ").includes("--help")
      ? {
          status: 0,
          stdout: supportsHookTrustBypass ? "codex --dangerously-bypass-hook-trust\n" : "codex\n",
          stderr: "",
        }
      : { status: 0, stdout: "codex-cli 0.132.0\n", stderr: "" };

export function installFakes(options: { readonly supportsHookTrustBypass?: boolean } = {}): void {
  setPlatformForTests("darwin");
  setCommandRunnerForTests(versionOk(options.supportsHookTrustBypass ?? true));
  setStartupWaitMsForTests(25);
  setPtyFactoryForTests((options) => {
    const pty = new FakePty(options);
    ptys.push(pty);
    return pty;
  });
}

export function resetFakes(): void {
  resetRuntimeSeamsForTests();
  resetStartupWaitMsForTests();
  resetPreflightCacheForTests();
  resetCodexPreflightCacheForTests();
  resetCodexSessionSeamsForTests();
  ptys.length = 0;
}

export function tempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "elwood-codex-"));
  mkdirSync(path, { recursive: true });
  return path;
}

export class FakePty implements PtyProcess {
  readonly pid = ptys.length + 1;
  readonly writes: string[] = [];
  readonly killSignals: string[] = [];
  readonly dataHandlers: ((data: string) => void)[] = [];
  readonly exitHandlers: ((exit: PtyExit) => void)[] = [];
  readonly options: PtySpawnOptions;
  size: TerminalSize;
  resizeResult: "resized" | "closed" = "resized";

  constructor(options: PtySpawnOptions) {
    this.options = options;
    this.size = options.size;
  }

  onData(handler: (data: string) => void) {
    this.dataHandlers.push(handler);
    return () => {};
  }

  onExit(handler: (exit: PtyExit) => void) {
    this.exitHandlers.push(handler);
    return () => {};
  }

  write(data: string | Uint8Array): void {
    this.writes.push(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
  }

  resize(size: TerminalSize): "resized" | "closed" {
    if (this.resizeResult === "resized") this.size = size;
    return this.resizeResult;
  }

  kill(signal = "SIGTERM"): void {
    this.killSignals.push(signal);
    this.emitExit({ exitCode: 0 });
  }

  emitData(data: string): void {
    for (const handler of this.dataHandlers) handler(data);
  }

  emitExit(exit: PtyExit): void {
    for (const handler of this.exitHandlers) handler(exit);
  }

  async dispatchHook(elwoodSessionId: string, input: Record<string, unknown>) {
    const { socketPath, token } = this.readBridge(elwoodSessionId);
    return await this.dispatchRaw(
      socketPath,
      JSON.stringify({ token, elwoodSessionId, input: JSON.stringify(input) }),
    );
  }

  async dispatchMalformedHook(elwoodSessionId: string) {
    const { socketPath, token } = this.readBridge(elwoodSessionId);
    return await this.dispatchRaw(
      socketPath,
      JSON.stringify({ token, elwoodSessionId, input: "not-json" }),
    );
  }

  private readBridge(elwoodSessionId: string) {
    const dir = join(this.options.cwd, ".elwood", "sessions", elwoodSessionId);
    const script = readFileSync(join(dir, "hook-bridge.mjs"), "utf8");
    return {
      socketPath: /const socketPath = "([^"]+)"/.exec(script)![1]!,
      token: /const token = "([^"]+)"/.exec(script)![1]!,
    };
  }

  private async dispatchRaw(socketPath: string, payload: string) {
    const net = await import("node:net");
    return await new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
      const client = net.createConnection({ path: socketPath });
      let response = "";
      client.on("data", (chunk) => {
        response += chunk.toString("utf8");
      });
      client.on("end", () => resolve(JSON.parse(response)));
      client.on("connect", () => {
        client.write(`${payload}\n`);
      });
    });
  }
}
