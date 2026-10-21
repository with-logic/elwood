/**
 * Public shapes for live Codex transcript observation.
 * Implements PRD §7A and §5.4 (C-API-12): the summarized view of one committed
 * Codex JSONL transcript item and the event carrying it to subscribers.
 */

/**
 * A typed, adapter-neutral projection of one committed Codex transcript item — the
 * shape delivered on `codex:transcript` and the unified `activity` stream. NOTE:
 * "bounded" refers only to the READER (it caps how much it reads/holds), NOT to
 * this projection's content — `text` below is untruncated conversation prose and
 * may be sensitive. Treat it as such; it is not a content-free/redacted channel.
 */
export type CodexTranscriptSummary = {
  /**
   * A short, human-readable label whose meaning depends on `kind`: the message
   * role (`assistant`) for `message`/`commentary`, the tool/function name for
   * `tool_call`, the correlating call id for `tool_result`, the web-search action
   * type (e.g. `search`/`open_page`) for `web_search`, the literal `"reasoning"`
   * for `reasoning`, and the payload item type, outer item type, role, or `"unknown"`
   * for `other` (depending on the record being summarized).
   */
  readonly label: string;
  /**
   * The item's readable prose, present only when the item genuinely carries some:
   * a message body, a tool invocation/output, a web-search query/target, or
   * reasoning summary text. This is UNTRUNCATED conversation content and MAY be
   * sensitive (full assistant messages, tool output, file contents) — subscribers
   * must not treat it as a content-free channel. Absent when the item has no
   * readable text — the common case for an empty reasoning summary or a non-textual
   * payload. It is required for `commentary`, absent for `other`, and optional
   * for the remaining variants. It never carries encrypted reasoning content,
   * which is deliberately not surfaced (§7A.4).
   */
  readonly text?: string;
} & (
  | {
      /** User-facing assistant progress, distinct from a final reply. */
      readonly kind: "commentary";
      readonly label: "assistant";
      readonly text: string;
    }
  | {
      /** Final messages, tool calls/results, reasoning, searches, or unsurfaced items. */
      readonly kind: "message" | "tool_call" | "tool_result" | "reasoning" | "web_search" | "other";
    }
);

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
   * never persist it into a content-free channel. The `summary` is a typed, readable
   * projection for rendering — its `text` is likewise potentially sensitive (see
   * CodexTranscriptSummary); `item` is provided for callers needing the raw shape.
   */
  readonly item: unknown;
  /** The typed, readable projection of `item` for activity rendering (its `text` may be sensitive). */
  readonly summary: CodexTranscriptSummary;
};
