/** Bounds optional review context while keeping recent records; gate decisions use full history. */
export async function recentHistory(method, args) {
  const first = await method({ ...args, per_page: 100, page: 1 });
  const lastLink = (first.headers?.link ?? "").split(",").find((link) => /rel="last"/u.test(link));
  const last = lastLink
    ? Number(new URL(lastLink.match(/<([^>]+)>/u)[1]).searchParams.get("page"))
    : 1;
  if (!Number.isSafeInteger(last) || last < 1) throw new Error("Invalid GitHub pagination");
  const start = Math.max(1, last - 2);
  const pages = [];
  for (let page = start; page <= last; page++) {
    pages.push(page === 1 ? first.data : (await method({ ...args, per_page: 100, page })).data);
  }
  return { records: pages.flat(), truncated: start > 1 };
}

export function boundedContext(title, body, records, truncated) {
  const result = { title, body, discussion: [], truncated };
  let bytes = Buffer.byteLength(JSON.stringify(result));
  if (bytes > 65536) {
    result.title = "PR text omitted: exceeds optional discussion context budget";
    result.body = null;
    result.truncated = true;
    bytes = Buffer.byteLength(JSON.stringify(result));
  }
  // Retain the newest whole records; never truncate text in a way that changes its meaning.
  for (let i = records.length - 1; i >= 0; i--) {
    const added =
      Buffer.byteLength(JSON.stringify(records[i])) + (result.discussion.length ? 1 : 0);
    if (bytes + added > 65536) {
      result.truncated = true;
      break;
    }
    result.discussion.unshift(records[i]);
    bytes += added;
  }
  return result;
}
