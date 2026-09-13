/**
 * Enforces the repository's 200-line maximum for code files.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const maxLines = 200;
const roots = ["src", "dev", "tests", "scripts", "examples"] as const;
const extensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const skippedDirectories = new Set(["node_modules", "dist", "coverage", ".git"]);

type Violation = {
  readonly path: string;
  readonly lines: number;
};

const violations = roots.flatMap((root) => collectViolations(root));

if (violations.length > 0) {
  const body = violations
    .sort((left, right) => right.lines - left.lines)
    .map((violation) => `  ${violation.lines.toString().padStart(4)} ${violation.path}`)
    .join("\n");
  process.stderr.write(`Files must stay at or below ${maxLines} lines.\n${body}\n`);
  process.exit(1);
}

process.stdout.write(`All checked files are at or below ${maxLines} lines.\n`);

function collectViolations(path: string): Violation[] {
  if (!exists(path)) return [];
  const stat = statSync(path);
  if (stat.isDirectory()) return collectDirectoryViolations(path);
  if (!shouldCheckFile(path)) return [];
  const lines = countLines(readFileSync(path, "utf8"));
  return lines > maxLines ? [{ path, lines }] : [];
}

function collectDirectoryViolations(path: string): Violation[] {
  const entries = readdirSync(path, { withFileTypes: true });
  const violations: Violation[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
    violations.push(...collectViolations(join(path, entry.name)));
  }
  return violations;
}

function shouldCheckFile(path: string): boolean {
  for (const extension of extensions) {
    if (path.endsWith(extension)) return true;
  }
  return false;
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  const normalized = content.endsWith("\n") ? content.slice(0, -1) : content;
  return normalized.length === 0 ? 1 : normalized.split(/\r?\n/u).length;
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
