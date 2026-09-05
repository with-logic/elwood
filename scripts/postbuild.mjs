/**
 * Marks the emitted Elwood CLI entry as executable after TypeScript compilation.
 * Implements PRD §12A and C-CLI-01.
 */

import { chmodSync, readFileSync } from "node:fs";

const entryPath = new URL("../dist/cli/entry.js", import.meta.url);
const firstLine = readFileSync(entryPath, "utf8").split("\n", 1)[0];

if (firstLine !== "#!/usr/bin/env node") {
  throw new Error("The emitted Elwood CLI entry is missing its Node shebang.");
}

chmodSync(entryPath, 0o755);
