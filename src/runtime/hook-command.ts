/**
 * Builds the Node-compatible hook-bridge command (PRD §6.1/§7A.1). Electron
 * embeds Node behind its own executable, which needs its documented run-as-Node
 * switch when a child hook invokes that executable directly.
 */

/** Quote one argument for the POSIX login shells used by both adapters. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Build a hook command for Node or an Electron-hosted Node main process. */
export function hookCommand(
  bridgeScriptPath: string,
  runtimePath = process.execPath,
  electronRuntime = process.versions["electron"] !== undefined,
): string {
  const runAsNode = electronRuntime ? "ELECTRON_RUN_AS_NODE=1 " : "";
  return `${runAsNode}${shellQuote(runtimePath)} ${shellQuote(bridgeScriptPath)}`;
}
