/**
 * Hard shutdown handling for the browser dev app.
 * Implements PRD §11.
 */

type ShutdownSignal = "SIGINT" | "SIGTERM";

type ShutdownProcess = {
  readonly pid: number;
  once(signal: ShutdownSignal, handler: () => void): unknown;
  kill(pid: number, signal: "SIGKILL"): unknown;
  exit(code: number): never;
};

type ShutdownInput = {
  readonly isTTY?: boolean;
  setRawMode?(enabled: boolean): unknown;
  on(event: "data", handler: (chunk: string | Uint8Array) => void): unknown;
  resume(): unknown;
};

export function installHardShutdown(
  processLike: ShutdownProcess = process,
  input: ShutdownInput = process.stdin,
): void {
  processLike.once("SIGINT", () => forceKill(processLike, 130, input));
  processLike.once("SIGTERM", () => forceKill(processLike, 143, input));
  if (input.isTTY) input.setRawMode?.(true);
  input.on("data", (chunk) => {
    if (isCtrlC(chunk)) forceKill(processLike, 130, input);
  });
  input.resume();
}

export function forceKill(
  processLike: ShutdownProcess,
  code: number,
  input?: Pick<ShutdownInput, "setRawMode">,
): never {
  try {
    input?.setRawMode?.(false);
    processLike.kill(processLike.pid, "SIGKILL");
  } finally {
    processLike.exit(code);
  }
}

export function isCtrlC(chunk: string | Uint8Array): boolean {
  if (typeof chunk === "string") return chunk.includes("\u0003");
  return chunk.includes(3);
}
