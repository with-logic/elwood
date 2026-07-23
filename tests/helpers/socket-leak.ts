/**
 * Pure, stateless helpers shared by both adapters' socket-leak conformance tests
 * (PRD §8.1/§9.1): enumerate socket homes/files under an isolated tmp and compute the
 * worst-case bound socket-path length so a long-`os.tmpdir()` machine can't mask a cap
 * overflow. Kept out of the test files only to keep them under the 200-line cap; the
 * stateful `isolateTmp`/`afterEach` deliberately stay per-test-file (no shared mutable
 * module state across test files).
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** `elwood-`-prefixed dirs under the private tmp — the socket-home shape. */
export function socketHomesIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((entry) => entry.startsWith("elwood-"))
    .map((entry) => join(dir, entry))
    .filter((full) => statSync(full).isDirectory());
}

/** `.sock` files across every socket home under the private tmp — the leak we guard. */
export function socketFilesIn(dir: string): string[] {
  return socketHomesIn(dir).flatMap((home) =>
    readdirSync(home)
      .filter((entry) => entry.endsWith(".sock"))
      .map((entry) => join(home, entry)),
  );
}

/** The worst-case bound socket path under an isolated tmp: <priv>/elwood-<16hex>/<8>.sock. */
export function boundSocketPathLength(priv: string): number {
  return priv.length + "/elwood-".length + 16 + 1 + 8 + ".sock".length;
}
