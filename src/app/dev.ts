/**
 * Manual local test app entrypoint.
 * Implements PRD §11.
 */

import { runTestApp } from "./test-app.ts";

await runTestApp(process.argv.slice(2), {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
});
