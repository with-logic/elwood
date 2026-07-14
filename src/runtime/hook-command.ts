/**
 * Builds the Node-compatible hook-bridge command (PRD §6.1/§7A.1). Electron
 * embeds Node behind its own executable, which needs its documented run-as-Node
 * switch when a child hook invokes that executable directly.
 */

import { shellQuote } from "./shell.ts";

/** Build a hook command for Node or an Electron-hosted Node main process. */
export function hookCommand(
  bridgeScriptPath: string,
  seams?: { readonly runtimePath?: string; readonly electronRuntime?: boolean },
): string {
  const runtimePath = seams?.runtimePath ?? process.execPath;
  const electronRuntime = seams?.electronRuntime ?? process.versions["electron"] !== undefined;
  const runAsNode = electronRuntime ? "ELECTRON_RUN_AS_NODE=1 " : "";
  return `${runAsNode}${shellQuote(runtimePath)} ${shellQuote(bridgeScriptPath)}`;
}
