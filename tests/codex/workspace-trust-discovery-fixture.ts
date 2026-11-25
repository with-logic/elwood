/** Reuse native Codex workspace trust fixtures across discovery tests (C-ATTN-07). */
import { realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { vi } from "vitest";
import { CodexWorkspaceTrustDiscovery } from "../../src/codex/workspace-trust/discovery.ts";
import { startCodex } from "../../src/index.ts";
import { tty } from "../fixtures/trust-composer.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";
import { installFakes, ptys, tempDir } from "./helpers.ts";

export const clear = "\x1b[2J\x1b[H";
const capturePath = "/tmp/elwood-native-CAPTURE";

export function menu(cwd: string, name = "folder-access"): string {
  return tty(capturedFrame(`codex-0.164.0/trust/${name}`).replace(capturePath, cwd));
}

export function menuWithQuitSelected(cwd: string): string {
  return menu(cwd).replace("› 1.", "  1.").replace("  2.", "› 2.");
}

export async function setup(options?: { readonly autotrust?: boolean }) {
  installFakes();
  const cwd = realpathSync.native(tempDir());
  const session = await startCodex({ cwd, ...options });
  const pty = ptys[0]!;
  const render = async (text: string) => {
    pty.emitData(clear + text);
    await session.terminal.settled();
  };
  return { cwd, session, pty, render };
}

/** Pause a selected filesystem lookup without changing its eventual result. */
export function proofPause() {
  const began = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  return {
    began: began.promise,
    release: release.resolve,
    wait: () => {
      began.resolve();
      return release.promise;
    },
  };
}

export async function interceptWorkspaceLookup(
  cwd: string,
  beforeLookup: (index: number) => Promise<void> | undefined,
) {
  const { lstat } = await vi.importActual<typeof fs>("node:fs/promises");
  const expected = join(cwd, ".git");
  let checks = 0;
  const lookup = vi.mocked(fs.lstat);
  lookup.mockClear().mockImplementation(async (...options) => {
    if (options[0] === expected) await beforeLookup(checks++);
    return Reflect.apply(lstat, undefined, options);
  });
  return { count: () => checks };
}

export function afterPublicationProof(callback: () => void) {
  const complete = Promise.withResolvers<void>();
  const { readForPublication } = CodexWorkspaceTrustDiscovery.prototype;
  vi.spyOn(CodexWorkspaceTrustDiscovery.prototype, "readForPublication").mockImplementationOnce(
    async function (this: CodexWorkspaceTrustDiscovery, ...args) {
      const verified = await readForPublication.apply(this, args);
      try {
        callback();
      } finally {
        complete.resolve();
      }
      return verified;
    },
  );
  return complete.promise;
}
