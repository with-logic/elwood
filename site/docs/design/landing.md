# Elwood landing page

The primary composition follows `references/elwood-screen.png`: a fine navigation rule, small suspended terminal, local sketched ground, central robot, full-width condensed headline, and the two supplied lines of copy. The alternate sideways composition was retired on September 10; only the wide poster remains. Mobile reflows the headline and navigation while keeping the artwork clear of text.

Palette: bold yellow #ffda1a; ink and rules #000000; signal #fa5426; white #ffffff for reversed text; neutral gray #b3b3b3 for secondary text inside black code panels. All foreground text on yellow is black. Orange is reserved for small decorative signals; links and focus indicators use high-contrast black or yellow. Anton supplies the condensed poster lettering; Roboto Mono supplies navigation, copy and the code example. Both are self-hosted with their licenses. The September 15 yellow-and-black reference defines the palette across the landing page, documentation, dialogs, browser chrome, icons and social cards. Preserve the existing composition and robot artwork. Shared theme tokens are the source for web styles and generated brand assets; the yellow ground stays flat, without a beige wash.

The robot owns the only continuous visual movement. Navigation and documentation remain ordinary HTML. The first five seconds show idle. Automatic actions then begin, yield immediately to manual controls, and resume after five quiet seconds in the current stance followed by 3.5 seconds of animated idle. A dialog behind `?` exposes the keyboard, pause and the way into the terminal. The terminal stays fixed while the tether follows the tracked socket. Ground marks stay at initial spawn and landing coordinates, with no full-width floor stripe. A static fine-grain SVG mask softens the headline ink. Pointer and keyboard pickup suspend the robot at the tracked connector; dedicated wriggle footage loops while suspended, then a falling pose leads into a planted three-point landing and recovery. Shift plus a movement direction selects the calibrated sprint gait.

Reset and responsive reflow discard pending explicit gesture and facing requests. A late sprite load cannot replay them into the reset World. Superseded requests release their sprite-load subscription, so a shared automatic load still reports its own failure. Failures owned only by a superseded request stay silent; a failure in the current request still appears in the asset-error area.

On phones, the four-row headline occupies at most 26% of the hero height (capped at 220 pixels), measured after fitting the lettering. The robot fits the remaining space above that ledge with at least 64 pixels of clearance below the terminal. It must never grow beyond that available space. Desktop keeps its existing two-line poster composition. Code examples fit the available column width; long code lines scroll inside their panels instead of widening the page.

Initial rendering uses one small static WebP, an inline SVG tether, local fonts and HTML/CSS. The static tether connects the terminal to the poster immediately, without waiting for JavaScript, metadata or sprite downloads. Layout updates keep it attached during loading. The poster and static tether stay visible until the first successful live canvas paint; they remain available if animation assets fail to load. Reduced motion retains a still, connected robot. Asset errors appear in document flow below the hero, leaving the terminal, cable and artwork unobstructed. They identify the failing relative asset path, bounded to 200 characters, and retain the underlying error for diagnostics. Sprite metadata and pages load on demand; the existing four-page decoded cache stays bounded. Sprite sheets decode one at a time in a dedicated worker when worker image bitmaps are available. The worker transfers decoded bitmaps directly so their pixels survive worker termination. Decoder requests accept an optional abort signal: cancellation rejects promptly, skips queued decodes before posting them to the worker, and never starts fallback decoding. An active createImageBitmap call cannot be physically interrupted; its eventual image is released without terminating the worker or disturbing other owners. The page dispatches only one worker request at a time and waits for physical completion acknowledgement even after the caller aborts. Abort listeners are removed when requests settle. Canvas-backed worker transfers are avoided because Chrome can clear their pixels when the originating worker terminates. Unavailable or failed workers fall back to main-thread createImageBitmap, then Image.decode when that API is unavailable. These fallbacks preserve rendering but do not guarantee stall-free decoding or first draws. Render-driven loading has one owner per missing metadata file or sprite page, regardless of the number of frames painted while it loads. An automatic load failure is reported once and is not retried by later paints. Explicitly preparing that animation again permits another attempt for its failed assets; unrelated animations keep their own failure state. Automatic silhouette-fit probes load only metadata and obey the same failed-asset latch. When explicit preparation and automatic rendering share a request, its failure is reported by the explicit caller once. Successful page loading and lookahead remain on demand. The renderer pauses when hidden, offscreen, paused, or the controls dialog is open. Reduced motion starts with a static robot and lets visitors opt into animation.

Verification: World, sprite, director, layout and loading/input tests, plus actual browser inspection at phone, tablet and desktop sizes. Validate HTML/CSS before scripts load, deferred or failed animation requests, first-paint handoff, and terminal interaction. Source inspection and CPU rendering must not be represented as browser screenshots.

Sprite resources belong to the four-page cache and to any retained current or outgoing transition pose. Eviction releases a resource only after neither pose needs it; the renderer borrows both poses synchronously. Reset, replacement, and completed blends release their old pose references. Scene teardown releases all resources, including a decode that finishes after teardown, and prevents new loads. A page entering the browser's back/forward cache retains its scene for restoration; permanent navigation tears it down. This ownership applies to both the landing scene and the internal animation workshop.

September 10 refinements: the headline reads HEADLESS INTERACTIVE / AGENT SESSIONS on two fitted lines capped at roughly a fifth of the hero, and on the wide poster that block is a solid ledge the robot stands on, falls off and climbs; the single ground mark stays centre screen; the ink mask is fractal-noise paper rather than speckles; the terminal's play button is centred and its cursor blinks; the walkthrough dialog is the terminal itself, expanded with a Web Animations transform and stripped to window, player and chapters, with light syntax colour; the tether is a verlet rope with collision; all three easter-egg worlds (letter playground, inside-the-terminal transcript, side-scrolling run) were built and cut the same day, so the poster stands alone; solid blocks push him out of their footprint so he can never be trapped in front of the lettering; the value-proposition prose moved to the top-right note beside a pulsing signal dot; the subtext states the value proposition (real Claude Code and Codex sessions in headless PTYs, on the normal subscription).

The terminal has a subtle play affordance and opens a native dialog with a scripted CLI / Vim / TypeScript walkthrough. Its four chapters can be paused, sought, or read as a transcript; opening it pauses the robot. It never executes commands. The main example uses ClaudeSession, followed by a shell pipeline example and links into a ten-page static developer field guide. The guide preserves the yellow/black palette but uses comfortable body text, a persistent desktop sidebar, an in-page contents list, copyable code, and on-demand search. Mobile navigation wraps above the article.

Metadata and atlas requests share one task per key across automatic loading and
explicit preparation. Cancelled subscribers release their claim immediately;
remaining consumers keep the task and its error reporting. A signal-owned decoded
page is retained before delivery and remains alive through cache eviction until
that signal is cancelled. Releasing it preserves cached and pose-owned images.

Initial landing handoff waits for every retained idle page, keeping the fallback
on failure and allowing explicit boot retry. Pre-ready input cannot cancel boot;
teardown can. Idle-only preparation does not fetch rotation.

The internal complete-animation preparation API loads the requested clip plus
idle and rotation (idle itself needs no rotation dependency). It starts at most three metadata requests, then at most four
page fetch/decode operations concurrently; worker decoding remains serial.
Preparation owns per-clip leases through candidate, delivered and active phases.
Only a ready matching candidate can publish. After prepare → publish, activation
supplies `currentName` (playing now) and `nextName` (requested or next transition
clip). This consumes delivered ownership even before an opening turn, so cancellation
cannot drop the request before its first pose. Unmatched activation cannot promote
a candidate; it only releases obsolete active clip leases. Once playback leaves the request, only current/next dependency
clips remain leased by that animation owner; cache and current/outgoing pose ownership
remain independent. Successful complete preparation also pins the idle clip (two
shipped pages) through one shared bank-lifetime lease. Later preparations reuse
these pages even after animation ownership changes and cache eviction. Failed or
cancelled candidates do not establish that lease; disposal releases it. Idle clips
larger than two pages use ordinary animation/cache ownership instead. Rotation
and requested action pages never gain a bank-lifetime lease.
The pose handoff receives the actual current pose first and outgoing blend second,
and retains both before releasing any dependency leases. After the requested
one-frame clip is retained for painting, its idle and rotation dependency leases
are released. Its requested page remains keyed and
leased so cache eviction cannot trigger a reload on the next paint. An opening
turn does not complete that handoff; current and outgoing poses remain protected
when dependency leases are released.
Repeating a static request after dependency release prepares the complete idle,
rotation and requested clip set again before reporting readiness.
Cancellation releases candidate and delivered owners, preserving active playback.
Landing gesture and front/back controls wait for every requested, idle and rotation
page before publishing input. Known dropped states (airborne, hanging, climbing,
landing, settling, pending jump/wind-up, dragging or held movement) avoid
preparation. Supersession and reflow cancel pending/delivered ownership; recovery queues retain delivery until
consumed or replaced, including when held movement clears the queue. Current and
outgoing poses remain protected. Automatic moments and facing actions also wait
for complete readiness; each task owns its cancellable geometry probe and prepared
delivery. Replacement removes only its matching queued input. Requested and shared
idle/rotation asset failures report once and suppress automatic retries across
actions until explicit preparation clears them. Successful delivery starts a fresh
task clock. Walking and pickup remain
on demand.
