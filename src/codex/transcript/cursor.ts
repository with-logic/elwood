/**
 * The Codex transcript cursor: the shared bounded forward reader, plus whether the file
 * has existed. Implements PRD §5.7 / §7A (C-CODEX-23): a transcript that has not been
 * created yet is waited on silently, but once it has existed its removal is a read race
 * that warns, as the Claude cursor's is (C-CLAUDE-24). The shared reader alone reads a
 * missing file as empty, which made a removal look like a truncation.
 */

import { statSync } from "node:fs";
import { errnoCode } from "../../core/errors.ts";
import { BoundedTranscriptCursor } from "../../core/transcript/cursor.ts";
import { observedSize } from "../../core/transcript/cursor-io.ts";

export class CodexTranscriptCursor extends BoundedTranscriptCursor {
  // Until a stat has seen the file, ENOENT means "not created yet", not a removal.
  private created: boolean;

  constructor(path: string) {
    // One stat gives both the start offset and whether the file exists, so the two can
    // never disagree about a file removed in between.
    const size = observedSize(path);
    super(path, size ?? 0);
    this.created = size !== undefined;
  }

  /**
   * Whether the file exists to be read. A file not created yet has nothing to scan; any
   * other failure, including ENOENT after the file existed, throws for the fs guard.
   */
  present(): boolean {
    try {
      statSync(this.path);
      this.created = true;
      return true;
    } catch (error) {
      if (!this.created && errnoCode(error) === "ENOENT") return false;
      throw error;
    }
  }
}
