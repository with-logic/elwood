/**
 * Converts Node argument-parser failures into concise, actionable CLI diagnostics.
 * Implements PRD §12A.5 and C-CLI-20.
 */

const longOptions = [
  "--agent",
  "--output",
  "--timeout",
  "--trust",
  "--no-trust",
  "--state-dir",
  "--verbose",
  "--no-verbose",
  "--stream",
  "--no-stream",
  "--debug",
  "--no-defaults",
  "--head",
  "--persona",
  "--model",
  "--reasoning-effort",
  "--claude-permission-mode",
  "--codex-sandbox",
  "--codex-approval-policy",
  "--cwd",
  "--image",
  "--keep",
  "--resume",
  "--ephemeral",
  "--help",
  "--version",
] as const;

export function argumentErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Could not parse command-line arguments.";
  const code = (error as Error & { readonly code?: unknown }).code;
  const match = code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ? unknownOption(error.message) : undefined;
  if (match === undefined) return error.message;
  const suggestion = nearestOption(match);
  return suggestion === undefined
    ? `Unknown option '${match}'.`
    : `Unknown option '${match}'. Did you mean '${suggestion}'?`;
}

function unknownOption(message: string): string | undefined {
  return /Unknown option '([^']+)'/u.exec(message)?.[1];
}

function nearestOption(input: string): string | undefined {
  if (!input.startsWith("--")) return undefined;
  const ranked = longOptions
    .map((option) => ({ option, distance: editDistance(input, option) }))
    .sort((left, right) => left.distance - right.distance);
  const best = ranked[0];
  if (best === undefined || best.distance > 2 || ranked[1]?.distance === best.distance)
    return undefined;
  return best.option;
}

function editDistance(left: string, right: string): number {
  let row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const next = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution =
        row[rightIndex - 1]! + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      next[rightIndex] = Math.min(row[rightIndex]! + 1, next[rightIndex - 1]! + 1, substitution);
    }
    row = next;
  }
  return row[right.length]!;
}
