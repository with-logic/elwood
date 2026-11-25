/** Reuse native Codex workspace trust fixtures across discovery tests (C-ATTN-07). */
import { realpathSync } from "node:fs";
import { startCodex } from "../../src/index.ts";
import { tty } from "../fixtures/trust-composer.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";
import { installFakes, ptys, tempDir } from "./helpers.ts";

export const clear = "\x1b[2J\x1b[H";
const capturePath = "/tmp/elwood-native-CAPTURE";

export function menu(cwd: string, name = "folder-access"): string {
  return tty(capturedFrame(`codex-0.164.0/trust/${name}`).replace(capturePath, cwd));
}

export async function setup() {
  installFakes();
  const cwd = realpathSync.native(tempDir());
  const session = await startCodex({ cwd });
  const pty = ptys[0]!;
  const render = async (text: string) => {
    pty.emitData(clear + text);
    await session.terminal.settled();
  };
  return { cwd, session, pty, render };
}
