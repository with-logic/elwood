/**
 * A stand-in for macOS `security` (`ELWOOD_E2E_SECURITY_BIN` in `tests/e2e/claude-login.ts`,
 * PRD §12, C-E2E-23), so the e2e Claude home's tests never read the user's keychain. It
 * holds at most one item, records the service each lookup names, and answers any other
 * lookup as `security` does when the item does not exist: exit 44.
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shellQuote } from "../../src/runtime/shell.ts";
import { tempDir } from "./tmp.ts";

/** One keychain item: a login stored under `service`, or a lookup that fails with `status`. */
type Item = { readonly service: string } & (
  | { readonly login: string }
  | { readonly status: number }
);

/** A fake `security` holding `item`, and the services looked up through it so far. */
export function fakeKeychain(item?: Item): { bin: string; lookups: () => readonly string[] } {
  const dir = tempDir("fake-keychain-");
  const bin = join(dir, "security");
  const log = join(dir, "lookups");
  const answer =
    item === undefined
      ? ""
      : "login" in item
        ? `[ "$3" = ${shellQuote(item.service)} ] && { printf '%s' ${shellQuote(item.login)}; exit 0; }`
        : `[ "$3" = ${shellQuote(item.service)} ] && exit ${item.status}`;
  // `keychainLogin` runs `security find-generic-password -s <service> -w`.
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$3" >> ${shellQuote(log)}\n${answer}\nexit 44\n`);
  chmodSync(bin, 0o700);
  const lookups = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter((line) => line !== "")
      : [];
  return { bin, lookups };
}
