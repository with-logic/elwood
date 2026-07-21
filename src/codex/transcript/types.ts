/**
 * Public shapes for live Codex transcript observation.
 * Implements PRD §7A and §5.4 (C-API-12): the summarized view of one committed
 * Codex JSONL transcript item and the event carrying it to subscribers.
 */

/**
 * A bounded, adapter-neutral summary of one committed Codex transcript item — the
 * shape projected into `codex:transcript` and the unified `activity` stream.
 */
export type CodexTranscriptSummary = {
  /**
   * The kind of activity this item represents. Drives which fields downstream
   * activity carries: `message` (assistant/user prose), `tool_call` (a shell/exec
   * or function invocation), `tool_result` (that call's output), `reasoning`
   * (chain-of-thought summary text, when present), `web_search`, or `other` (any
   * item type not specifically surfaced).
   */
  readonly kind: "message" | "tool_call" | "tool_result" | "reasoning" | "web_search" | "other";
  /**
   * A short, human-readable label whose meaning depends on `kind`: the message
   * role (`assistant`/`user`) for `message`, the tool/function name for
   * `tool_call`, the correlating call id for `tool_result`, the web-search action
   * type (e.g. `search`/`open_page`) for `web_search`, the literal `"reasoning"`
   * for `reasoning`, and the raw item `type` (or `"unknown"`) for `other`.
   */
  readonly label: string;
  /**
   * The item's readable prose, present only when the item genuinely carries some:
   * a message body, a tool invocation/output, a web-search query/target, or
   * reasoning summary text. Absent when the item has no readable text — the common
   * case for an empty reasoning summary or an item whose payload is non-textual —
   * so subscribers must treat it as optional. Never carries encrypted reasoning
   * content, which is deliberately not surfaced (§7A.4).
   */
  readonly text?: string;
};

/**
 * One live, best-effort observation of a committed Codex transcript item.
 * Best-effort: the reader is bounded (fixed-size chunk reads, a max-pending
 * ceiling), so a pathological or oversized record is dropped and accounted rather
 * than delivered — an event here is always a genuinely committed, parseable item.
 */
export type CodexTranscriptEvent = {
  /** The Elwood session whose transcript produced this item. */
  readonly elwoodSessionId: string;
  /** The absolute filesystem path of the JSONL transcript this item was read from. */
  readonly path: string;
  /**
   * The raw, parsed JSONL record exactly as Codex wrote it. This is LIVE transcript
   * content and MAY be sensitive — it can embed prompts, tool output, file
   * contents, or other conversation data — so subscribers must treat it as such and
   * never persist it into a content-free channel. The bounded `summary` is the
   * safe projection; `item` is provided only for callers that need the raw shape.
   */
  readonly item: unknown;
  /** The bounded, content-safe projection of `item` used for activity rendering. */
  readonly summary: CodexTranscriptSummary;
};
