# The Elwood website

This is the landing page and generated documentation site for Elwood, deployed to
Vercel from this repository. It is static: HTML, CSS, ES modules, and sprite
sheets, with no framework and no build step.

A responsive landing page for the Elwood TypeScript library, with a wandering robot made from the generated animation footage. The poster layout follows the supplied wide reference; the sideways poster has been retired. The terminal stays fixed while a verlet rope with floor and block collision follows the robot, draping over the headline when he is down beside it. On the wide poster the two-line headline (HEADLESS INTERACTIVE / AGENT SESSIONS) is a solid ledge: he stands on it above one patch of pen-like ground that stays centre screen, can walk off either side to the baseline, and climbs back up. Each headline line is fitted to the poster width, then the block shrinks so the robot keeps room and cable. The headline texture is a soft fractal-noise paper mask, not speckles.

## Run

```sh
python3 -m http.server 8766 --bind 127.0.0.1
```

Open [the landing page](http://127.0.0.1:8766/). No build step, framework, WebGL, Three.js, or external runtime service is required. `playground.html` is the internal animation workshop used to tune the robot's motion: it is not linked from the site and `.vercelignore` keeps it out of the deployment. The 4K production masters and their review gallery live outside this repository (see the repository `.gitignore`); the runtime sprite sheets under `assets/game/` are committed.

Elwood idles for five seconds on arrival, then wanders by default, mixing walks, camera-facing turns, 28 personality moments and pauses. Arrow keys take over immediately. After manual control stops, he holds his stance for five seconds, then plays animated idle for 3.5 seconds before resuming exploration. Held poses recover before that idle period. Sitting, crossed arms, fainting and floating linger for varying periods under automatic control, then recover before the next action. Manual holds remain until another action or the inactivity handoff.

Press **?** for the clickable keyboard and pause. There is no easter-egg world at the moment: the letter playground, the inside-the-terminal transcript and the side-scrolling run were all built and cut on September 10; the poster itself is the whole show. There are no on-screen movement controls: the robot is driven by keyboard and by picking him up, so touch devices get the ambient wandering rather than manual control. Reduced motion starts still and requires explicit interaction to animate.

The value proposition (real Claude Code and Codex sessions in headless PTYs, on the normal subscription rather than usage-based billing) sits top right beside a pulsing signal dot, replacing the old REAL PTY / OPERATOR note and the line under the headline. Documentation opens the [developer guide](http://127.0.0.1:8766/guide/), grounded in the library and CLI at the repository root. The page uses `ClaudeSession` and the planned `@with-logic/elwood` package name. Click the suspended terminal (centred play button, blinking cursor) and it grows into a dark four-chapter scripted walkthrough with pause, seek and chapter navigation, then shrinks back on close. Shell, JSON and Vim/TypeScript lines get light syntax colour from a tiny tokenizer that never alters the text. The examples omit `--agent`; the CLI auto-detects Claude, then Codex. No commands execute and no agent API is called.

Pick up the robot with a mouse or touch to make him wriggle in the air; release for a fall and three-point landing. Keyboard users can focus the robot, press Enter, move with arrows, and press Enter again to drop. Hold **Shift + left/right** to sprint. The new footage is reviewed, upscaled to 4K and exported at native 24 fps. Skid and running-flip briefs remain available for a later batch.

| Keys | Actions, in order |
| --- | --- |
| Left / right arrows or A / D | Move |
| Shift + left / right | Sprint |
| Space | Jump |
| Up, W or E | Grab a reachable ledge; press again to climb |
| Down or S | Drop or step off a platform |
| F / B | Face the camera / face away |
| 1 / 2 / 3 / 4 / 5 | Think / shrug / wave / bow / touch toes |
| 6 / 7 / 8 / 9 / 0 | Tiptoe / pond hops / balance / cross arms / sit cross-legged |
| Q / T / Y / U / I / O | Leg stretch / big stretch / yawn / kiss / check the time / bashful toe |
| G / H / J / K / L | Peace sign / juggle / sneeze / faint / float |
| Z / X / C / V | Cartwheel / remove and inspect an arm / hero punch jump / disco |
| N / M / comma | Dust off / air guitar / victory |
| P / R | Pause or resume / return home |
| ? / Escape | Open shortcuts / close shortcuts |

Jumping into a reachable edge catches it automatically; low blocks can be jumped onto directly. Ordinary gestures can be interrupted. Crossed arms, sitting and fainting hold until another action; floating gently plays its middle frames forward and backward. All four recover before the next action begins. Cartwheel, arm inspection and hero jump also finish their recovery first. Choosing the same held gesture again releases it. Reset always returns home immediately.

## Animation registration

- The right walk uses source frames **85–120** (3.542–5.042 seconds, end excluded). The left walk uses **107–143** (4.458–6 seconds). Both start after the generated turn-in footage.
- Ground travel is 72 world pixels/second, calibrated to roughly 65–75 pixels/second of planted-foot motion in the source at the displayed height. Walking retains its native 24 fps, with phase advancing in proportion to speed. Jumping uses the same 72 pixels/second with gentler air acceleration; the letter gaps are now 40 pixels.
- Sprint uses two complete strides (29 native frames), with travel calibrated to about 280 world pixels/second from planted-foot motion. Walk/sprint changes match the nearest leg pose; reversals still rotate. Pickup keeps the cable fixed to the tracked plug in every wriggle frame. Release locks horizontal travel until the three-point landing finishes its planted recovery.
- Ordinary idle poses face the last movement direction. Stopping and resuming the same gait blend directly between walk and idle, without inserting a rotation to correct small angle differences between the takes. F and B select persistent front/rear stances; movement resumes a side-facing gait. The rear stance is a new generated still, keyed and color-matched locally. The shortcut dialog's clickable keyboard also exposes both stances.
- The animated idle plays forward and backward at native 24 fps, reversing without duplicating either endpoint. The shrug plays once at 2× speed (about 2.33 seconds), as does the peace sign (about 2.5 seconds); toe touch plays at 1.5× speed (about four seconds); other one-shot gestures retain their original speed and finish at the available rotation pose nearest their ending angle. That orientation persists until another action. Crossed arms, sitting and fainting pause on reviewed middle frames indefinitely. Floating bounces between source frames 60 and 80 at normal 24 fps (about 1.67 seconds per round trip). A queued request plays the remaining recovery from the currently displayed pose before beginning.
- Tiptoe moves forward at 36 world pixels/second, matched to about 36.4 pixels/second measured planted-toe motion in its source. Its native 24 fps phase follows distance. Pond hops preserve the source's airborne rises and move forward only during those flight windows, at up to 52 pixels/second and about 50 pixels per performance. Each landing stops immediately. Balance, stretches, sitting and other stationary gestures register their lowest supported point to the floor while retaining body motion.
- Cartwheel travel cancels the backward sweep of the hands and feet against the source floor, measured offline from the actual 4K cutouts. It moves about 102.5 world pixels in the facing direction and stays at its new position afterward. Hero jump, faint and float retain their recorded trajectory against a fixed source floor and origin, without a second physics jump. Moonwalk is retired from the playground.
- Arm inspection uses the original take’s clean opening frames 0–60, pauses for half a second, then reverses frames 59–0 to reattach the same arm. This 5.54-second edit removes the confused scratching sequence.
- A shared rotation atlas covers front, side, and rear views. Its front sweep uses one continuous source sequence and its reflection, eliminating the hitch from joining the original take’s end to its beginning. Offline torso comparisons around the tracked connector estimate the orientation of every action frame. Grounded changes rotate along the shortest arc from the current frame to the next action’s entry pose, including reversals, gestures, jump preparation, and camera-facing stances. Small turns use only the needed part of the atlas. Turning takes about 0.12–0.55 seconds and holds position; new input can retarget a turn from its current angle.
- Turn timing waits for required image pages to decode. The walking cycle begins at its selected stance after the turn. A 75 ms pose blend softens take changes, including seams within the rotation atlas. Its colors and alpha are combined on a small transparent canvas before drawing onto the scene, preventing the pale flash from two overlapping fades. Matching source images at identical positions skip the blend entirely. Reduced-motion settings disable blending and camera easing. In flight, direction keys steer without flipping the airborne pose; the requested facing turns after the landing plant.
- Jump anticipation, ascent and descent use separate portions of the jump clip. Touchdown uses source frames at 4.125–4.333 seconds, locks horizontal position and facing for 250 ms, then holds the final planted pose until movement resumes. Each landing frame removes the video’s baked vertical movement. Anticipation also plants the feet.
- Climbing uses the replacement right-facing take: chest, knees and toes face toward the ledge through the hang, knee placement, forward mantle and standing recovery. Its mirror supplies the left-facing climb. Source frames 48–209 play at 48 fps, taking 3.375 seconds. A measured prop corner cancels small source drift. Climbing retains its exact final image, re-registered from the ledge to the feet using an exported offset. That standing pose already matches the forward walking entry angle, so continuing forward needs no about-face. Jump presses survive any requested turn. Outgoing blends preserve the old image’s world anchor.
- Tether attachment is tracked on the physical plug tip in every source frame, including crouches, leaning jumps, raised hands and sideways climbing poses. The hanging take tracks the rigid neck base through brief forearm occlusion. Exported attachment coordinates use the same scale, registration, and mirroring as the image. During blends, both images align at the interpolated connector so the cable stays attached.
- Hanging and climbing share the same source pose and fixed ledge coordinates. The climb plays at 2× speed. Left-facing jump/climb/gesture variants mirror their corresponding right-facing assets; walking left uses its actual separate take. Front and rear stances do not mirror.
- The grab/hang, climb, step-down, tiptoe and the newer human gestures are color-matched to the idle/walking palette, retaining shaded detail and alpha. Corrected video copies are `graded.mp4` and `4k-graded.mp4`; original footage remains intact. Gallery links prefer the corrected versions.

See [the action controller notes](docs/controller-actions.md) for enter/hold/exit phases, queued requests and the interface a future autonomous scheduler can use.

## Performance

The landing page first displays a 126 KB static WebP with an inline SVG cable, so the connection is visible before animation metadata or sprite pages download. Both remain until the first successful live canvas paint, including on slow or failed asset requests. On phones, the headline is capped at 26% of hero height (220 pixels maximum), leaving at least 64 pixels between the terminal and the robot; layout fitting measures the rendered headline rather than estimating its line height. HTML, styles, modules, fonts, metadata and the first idle atlas total about **2.3 MB uncompressed**. No video is fetched. Other actions are prepared only when selected, without preloading the animation library. The game has 4,808 frames across 46 runtime clips (150.47 MiB of WebP pages in total, loaded on demand). It uses 384-pixel standing-height WebP sprites for a 136-world-pixel character. The workshop displays that at its original scale; the landing page sizes the character to the available space above its headline, up to 260 CSS pixels. This layout change does not replace or recompress the existing sprites. The full-resolution PNG masters remain in `assets/production/sprites/`. Animation pages load on demand and the page cache retains four decoded sheets. Sprite sheets decode one at a time in a dedicated worker when worker image bitmaps are available. The worker transfers the decoded bitmap directly, preserving its pixels after the worker terminates. Unavailable or failed workers fall back to main-thread createImageBitmap, then Image.decode when that API is unavailable. These fallbacks preserve rendering but do not guarantee stall-free decoding or first draws. The scene artwork is drawn once to an offscreen canvas. Transitions reuse one small character-sized canvas at display resolution, aligned to the camera's pixel grid. Resting animation paints at 24 fps, active movement and short blends use the display refresh rate, and hidden, offscreen, unfocused or paused landing pages stop scheduling animation. Opening either the shortcut dialog or terminal walkthrough also pauses the scene. The walkthrough module loads only on the first terminal click; docs search loads its index only when opened. Headline grain is a static SVG mask. Idle physics reuses empty inputs, while static letter measurements and ground marks are cached. The game does not make generation API calls.

## Asset pipeline

The complete production archive and generation budget are documented in [assets/production/README.md](assets/production/README.md). The user increased the cap to 600 seconds. Total generated footage is **320 / 600 seconds**, leaving **280 seconds**, including the rejected six-second tiptoe take, eight-second cropped quad stretch and eight-second arm replacement. The replacement climb, tiptoe and personality library use 4K masters at native 24 fps. The newest batch adds sprinting, pickup wriggling and a three-point landing (21 generated seconds). The preceding batch added ten varied performances: cartwheel, arm inspection, punch jump, disco, peace sign, juggling, sneeze, faint, float and kiss. The wider acrobatics reference keeps limbs within the frame. The original arm take’s later anatomy issue was caught during interactive review. An eight-second replacement also produced an extra forearm and was rejected before upscaling; the game now uses a shorter clean edit of the existing 4K take. The earlier leg-stretch retry keeps the free hand close to the chest so the full silhouette stays visible. Their exact briefs, image prompts, reference frames and reviews are saved under `assets/production/`. The first tiptoe take was rejected before upscaling because its legs did not alternate; the replacement uses a clear stepping reference.

```sh
uv run scripts/match_robot_color.py
uv run scripts/track_connectors.py
uv run scripts/track_ledge.py 15-climb-right
uv run scripts/track_ground_motion.py
uv run scripts/build_game_assets.py
uv run scripts/validate_game_assets.py
python3 scripts/build_video_review.py
python3 scripts/build_production_gallery.py
python3 scripts/validate_production.py
```

Color matching is repeatable and skips already-corrected exports. Previous sprite exports are archived in the system temporary directory before replacement. `assets/production/color-profile.json` stores the reference palette. `assets/game/manifest.json` stores gameplay frame counts and transition mappings; each action’s `clip.json` stores source timestamps and tracked anchors. `assets/production/connector-tracks.json` stores source-coordinate plug locations; `review/connector-checks/` contains enlarged visual checks. `game-validation.json` records all-frame geometry and alpha checks for the attachment points.

## Verification

```sh
node --test tests/*.test.mjs
```

The workshop tests cover the physics/navigation chain and the actual page module’s single-key and virtual-keyboard handlers, pause/resume/reset, real asset loading, direction-specific selection, camera-facing controls, partial rotations, retargeting/loading during turns, planted landings, jump and tiptoe speeds, idle reversal, shrug timing, gesture endpoints, indefinite holds, reversible hover loops, queued recoveries, measured cartwheel travel, clean arm reassembly, retired moonwalk controls, source-motion tricks, hop flight windows, uninterrupted turn source order, exact anchor continuity, shared tether attachment through blends, and finite canvas drawing coordinates. The page-module test supplies a DOM/canvas spy; it does **not** test actual browser layout or image rendering. Asset validation checks dimensions, source frame counts, transparent PNGs, atlas rectangles, and exact sampled master pixels.

The landing, walkthrough and documentation tests additionally exercise varied autonomous sequences against the real World and manifest, immediate manual takeover, held-pose recovery, visible idle before automatic resumption, bounds, one-way letter platforms, idle-only initial loading, stale asynchronous requests, nested pause reasons, reduced motion, the four-page cache, stationary dirt, pointer/keyboard pickup, walkthrough seeking and lifecycle, and documentation search.

Four additional CPU raster tests use an optional development-only canvas package. They check actual composited pixel values, transparent edges, mirroring, camera offsets, buffer reuse, and the real robot assets. They also write a [before/after comparison](docs/reviews/transition-blends.png). Run them separately without adding a browser dependency:

```sh
npm install --prefix /tmp/elwood-canvas-check --no-package-lock --ignore-scripts @napi-rs/canvas
node scripts/verify_sprite_blends.mjs /tmp/elwood-canvas-check/node_modules/@napi-rs/canvas
```

Live browser playback and desktop/mobile screenshots could not be exercised because the in-app browser reported no available targets. This remains a visual-verification limitation. The world uses simple platform rectangles; letter holes are not separate collision geometry. The workshop and extended letter world show top rails. The poster uses invisible one-way collision bounds on the HTML letters. See [the latest validation notes](docs/reviews/new-motions.md) for evidence and remaining checks.

## Developer documentation

Edit the ten source sections in `docs/guide/`, then regenerate the single-page guide (`guide/index.html`, with a scroll-following contents list, per-section "Copy as Markdown" and "Copy all"), the Markdown twins, redirect stubs for the old per-page URLs, the search index and `llms.txt` / `llms-full.txt`:

```sh
uv run scripts/build_docs.py
python3 scripts/check_doc_examples.py
```

The builder reads CLI help from `src/cli/help.ts` at the repository root; it never edits the library. The example check uses its installed TypeScript compiler to check all 15 guide, landing and walkthrough examples without starting an agent. The generated guide is deployable as static files and readable without JavaScript.

Pickup rendering can also be checked using the same optional CPU canvas package:

```sh
node scripts/verify_pickup.mjs /tmp/elwood-canvas-check/node_modules/@napi-rs/canvas
```

The pickup check verifies all 336 suspended connector positions across both directions, exact release attachment and recovery, then renders a [motion inspection sheet](docs/reviews/new-motions.png).

## Brand assets

The public site uses bold yellow and black throughout. `theme.css` owns the
shared palette for the landing page, guide, and generated social cards and icons.
Keep browser theme metadata and `assets/landing/site.webmanifest` in sync when
changing the background. Regenerate the artwork from the existing robot and fonts:

```sh
uv run --with 'fonttools[woff]' --with pillow scripts/build_social_card.py
```

This writes both social-card formats, the 512px icon, Apple touch icon, and
multi-size favicon, and light/dark README marks. The transparent robot and animation sprite sheets retain
their original artwork.
