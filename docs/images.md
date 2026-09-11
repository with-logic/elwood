# Attaching images

Purpose: how to attach image content to a turn, what is validated, and how
each adapter ingests it.

`send`, `stream`, `sendPrompt`, `sendMessage`, and `sendGuidance` accept an
optional `images` list so a submission can carry image content alongside its
text, the equivalent of pasting or dragging an image into the CLI. It is an
attached-content model, not interleaving: images have no position within the
text, but the list is ordered (array order sets chip order). Elwood attaches
them as part of the same queued turn, before the text is submitted. The CLI
exposes the same thing as a repeatable `--image <path>` flag.

```ts
await session.sendMessage("What's wrong with this screenshot?", {
  images: [
    { path: "/abs/path/to/shot.png" },  // an existing image file
    { data: pngBytes, format: "png" },   // or in-memory bytes
  ],
});
```

## Validation and limits

`ImageInput` is exactly `{ path }` or `{ data, format }` where `format` is
`"png" | "jpeg" | "gif" | "webp"`; extra keys are rejected. Inputs are
validated before anything reaches the composer:

- At most 16 images per submission.
- At most 25 MiB per image and 50 MiB per submission, counting path inputs
  and byte inputs alike.
- At most 200 MiB of cloned image bytes held across all queued, not yet
  attached submissions in one session.

A violation rejects the call with `invalid_image`. Malformed or over-limit
input rejects synchronously, before the submission takes a queue slot. Path
readability is checked at dispatch, so a file made unreadable after the call
still rejects. A `{ data }` buffer is cloned at the call, so mutating it
afterwards does not change what is attached. Byte inputs are written to a
short-lived temp file that is removed once the submission is attached.

## Confirmation

Attachment is confirmed, never assumed. Each image waits for the CLI's
`[Image #N]` chip on the composer line. If the chip is not confirmed within
10 s, or the clipboard cannot be read or written, the call rejects with
`image_attach_failed` and no text is submitted. If the session terminates
mid-attach the call rejects with `session_not_running`, like any queued
operation. An attach rejection leaves queue readiness unchanged.

## Adapter mechanics

Each CLI ingests images through its own native path, so behavior differs.

**Claude** reads a pasted absolute image path itself. Elwood bracketed-pastes
each path (the same delivery a terminal produces on drag-and-drop), Claude
encodes the file, and an `[Image #N]` chip appears. The mechanism is
platform-neutral, but Elwood itself currently supports macOS only: both
adapters reject at startup with `unsupported_platform` elsewhere.

**Codex** ingests an interactive image only from the OS clipboard (Ctrl+V).
Elwood snapshots your clipboard once, writes each image onto the macOS
pasteboard, sends Ctrl+V, waits for the `[Image #N]` chip, and then restores
your prior clipboard. The whole transaction runs under a process-wide lock so
concurrent Codex sessions cannot cross-attach. Restoring the clipboard is
best-effort (text contents), and there is a brief window during the attach
when the injected image is the clipboard's contents.
