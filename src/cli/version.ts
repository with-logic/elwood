/**
 * Reads the package version from the installed package boundary.
 * Implements PRD §12A.1 and C-CLI-02.
 */

import { readFileSync } from "node:fs";

/** Return the version belonging to this compiled CLI installation. */
export function readCliVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { readonly version: string };
  return packageJson.version;
}
