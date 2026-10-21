/** Parse dense native option selection without pasted editor rows (PRD §4). */
export function nativeSelection(body: readonly string[], paged: boolean): number | undefined {
  const content = body.filter((line) => line.trim().length > 0);
  const rows = content.slice(paged ? 2 : 1);
  let count = 0;
  let selected: number | undefined;
  for (const line of rows) {
    const match = /^ {2}(› | {2})(\d+)\. /.exec(line);
    if (!match || Number(match[2]) !== count + 1) break;
    if (match[1] === "› ") selected = count;
    count += 1;
  }
  // Native queued choices include Other; modal choices include None of the above.
  return count > 1 ? selected : undefined;
}
