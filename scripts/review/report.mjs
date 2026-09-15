/** Checks review evidence against the Markdown contract in .claude/skills/review/SKILL.md. */
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const lenses = readFileSync(new URL("./lenses.txt", import.meta.url), "utf8")
  .trim()
  .split(/\r?\n/u);
const headings = /^ {0,3}#{1,6}[\t ]+(?:\*\*)?(blocker|major|minor|nit)(?:\*\*)?:[^\n]+$/gimu;
const fields = ["Confidence", "Location", "Finding", "If unfixed", "Fix", "Fix cost"];

export function findings(body) {
  const matches = [...body.matchAll(headings)];
  if (!matches.length) return null;
  const counts = { blocker: 0, major: 0, minor: 0, nit: 0 };
  for (const [index, match] of matches.entries()) {
    const content = body.slice(match.index + match[0].length, matches[index + 1]?.index);
    if (!fields.every((field) => new RegExp(`^- ${field}: \\S`, "imu").test(content))) return null;
    counts[match[1].toLowerCase()]++;
  }
  return counts;
}

export function validLens(body) {
  return body.trim() === "No findings." || findings(body) !== null;
}

export function reportCounts(body) {
  const parts = body.split(/^### (review-[a-z-]+)[\t ]*$/mu);
  if (parts.length !== 1 + lenses.length * 2) return null;
  const seen = new Set();
  const totals = { blocker: 0, major: 0, minor: 0, nit: 0 };
  for (let i = 1; i < parts.length; i += 2) {
    const lens = parts[i];
    const content = parts[i + 1].split(/^## /mu)[0].trim();
    if (!lenses.includes(lens) || seen.has(lens)) return null;
    seen.add(lens);
    if (content === "No findings.") continue;
    const counts = findings(content);
    if (!counts) return null;
    for (const severity of Object.keys(totals)) totals[severity] += counts[severity];
  }
  const coverage = body.split(/^## Reviewer Coverage[\t ]*$/mu);
  if (coverage.length !== 2) return null;
  const coverageBody = coverage[1].split(/^## /mu)[0];
  const entries = [...coverageBody.matchAll(/^- (review-[a-z-]+): (.+)$/gmu)];
  if (
    entries.length !== lenses.length ||
    new Set(entries.map((entry) => entry[1])).size !== lenses.length
  )
    return null;
  if (
    !entries.every(
      (entry) =>
        lenses.includes(entry[1]) &&
        /^(?:no findings|completed|\d+ findings?)(?:$|[,;.(\s])/iu.test(entry[2]) &&
        !/\b(?:missing|failed|incomplete|timed out)\b/iu.test(entry[2]),
    )
  )
    return null;
  if ([...body.matchAll(headings)].length !== Object.values(totals).reduce((sum, n) => sum + n, 0))
    return null;
  return totals;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  if (!validLens(readFileSync(process.argv[2], "utf8"))) {
    console.error("review: lens output does not match the finding schema");
    process.exitCode = 1;
  }
}
