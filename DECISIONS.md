# Decisions log

Choices made while building, with the reason for each. Where the implementation departs from `PLAN.md`, it says so. Newest phase at the bottom.

## Phase 1: scene format, engine, MCP

**Scene nodes are one list with a `kind` field** (`device`, `plane`, `primitive`, `group`, `text2d`), as the plan proposed. One ID namespace covers nodes and lights, and `camera` is reserved. Tracks target any of them by ID.

**Rotations interpolate as Euler degrees by default, not quaternions.** Quaternion slerp can't express a 360° spin: start and end are the same orientation, so a turntable would not move. Turntables are the most common mockup motion, so `linear` lerps Euler angles, and `interpolation: "slerp"` opts into shortest-path quaternions. *Departure from the plan (§3 said slerp).*

**Keyframe easing applies to the segment that starts at that keyframe** (After Effects / GSAP convention). The default is `linear`, which is predictable; the tool descriptions steer agents toward `easeInOut`.

**Camera position/target with 3+ keyframes follow a Catmull-Rom spline automatically**, so orbits are smooth without extra parameters.

**Camera orientation is position + target + roll**, not a free rotation. It's easier for agents to reason about and animate, and it can't produce a camera looking at nothing.

**Auto-framing (`set_camera { frame: { shot } }`) is exact**: it binary-searches the camera distance until every corner of the targets' boxes is inside the frustum with the requested padding. The unit tests assert every corner is in view for each shot.

**`update_node` takes a JSON Merge Patch (RFC 7396)** instead of per-field setters. That's one tool instead of `set_device_transform` / `set_device_material` / `set_device_screen`, and it keeps the tool count at 26.

**File paths are accepted anywhere an asset is expected** (`add_device { screen: 'design/home.png' }`, `set_background`). They're imported automatically and deduplicated by path and content hash. `import_asset` is still there for naming and reuse.

**Every mutating tool returns `issues`** (validation errors and warnings for the whole scene after the change), so agents notice problems like keyframes past the end of the timeline without calling `validate_scene`.

**Presets are data**: lighting presets and camera shots live in `packages/core/assets/presets/*.json`, device models in `packages/core/assets/devices/*.json`. Built-in assets ship inside `@devicewrapper/core` rather than a top-level `assets/`, so they're included when the package is installed from npm. *Small departure from the plan's folder layout.*

**Users can add device models without code** by dropping JSON into `<workspace>/.devicewrapper/devices/`.

**The renderer interface lives in core; jobs doesn't depend on the renderer.** `RenderBackend` is defined in `@devicewrapper/core`, the job queue uses only that interface, and the CLI wires in the Three.js backend. That keeps the dependency graph `schema ← core ← (renderer, jobs) ← mcp, cli`, and a Blender backend would slot in the same way. *Small departure from the plan (§2 had jobs → renderer).*

**Jobs snapshot the scene when queued**, so an agent editing the scene while a render runs doesn't change that render. Job records are persisted; on restart, unfinished jobs are marked `failed: INTERRUPTED` rather than silently lost.

**Workspace = the directory the server starts in.** All reads and writes are `realpath`-checked against the workspace (plus opt-in extra roots). Symlinks pointing outside are rejected, and paths are stored workspace-relative so scenes stay portable.

## Phase 2: renderer

**Three.js in headless Chromium (Playwright), SwiftShader by default.** Verified: WebGL2 with 4× MSAA on SwiftShader; identical bytes across repeated renders; 1920×1080 with 2× supersampling in ~6 s on 2 CPU cores. `DEVICEWRAPPER_RENDER_MODE=fast` enables the GPU when present.

**Chromium only draws; Node does the image work.** Screenshots are cropped, rotated and fitted with sharp at the device's native screen resolution before upload, so what you see matches the screenshot pixels. Backgrounds, vignette, grain and text are composited in a 2D canvas under or over the WebGL layer, which gives exact background colors (no tone mapping) and makes transparent output trivial. Final downscaling from the supersampled buffer uses Lanczos in sharp.

**Screens are unlit (exact colors) with a separate additive glass layer for reflections.** An early version used an emissive material, and direct-light highlights blew the UI out to white at grazing angles. `screen.glare` now scales the whole reflection layer, so glare can never wash out the content beyond what you ask for.

**Soft shadows use VSM** (variance shadow maps), with the shadow camera fitted tightly around shadow casters every frame, so shadows are crisp at any scene scale. `softness` maps to blur radius. Two artifacts found and fixed: hard edges (blur radius was too small) and a faint line across large floors where they crossed the shadow camera's far plane (depth range widened).

**Key lights in presets sit higher** (e.g. studio key at [1.5, 5, 2.5]). Long raking shadows looked odd on product shots.

**Text is drawn with bundled Inter (OFL, from `@fontsource-variable/inter`)**, covering Latin, Latin Extended, Cyrillic, Greek and Vietnamese. CJK text falls back to whatever system fonts exist (the Docker image includes Noto). A font imported as an asset can be used by its asset ID as `font`.

**The browser starts lazily** on the first render, so `devicewrapper mcp` connects instantly and an idle server uses no Chromium memory.

**`render_preview` returns the PNG inline** as MCP image content (plus the saved path), so the agent can look at its work and iterate.

## Phase 3: video

**Frames go straight from the page to FFmpeg as raw RGBA.** For video, the page downsamples the supersampled frame in a 2D canvas and POSTs raw pixels to Node, which pipes them into FFmpeg's stdin with backpressure. Nothing is buffered beyond two frames, and nothing is PNG-encoded per frame. Stills still use the PNG + Lanczos path for best quality.

**The page is served from a loopback HTTP server, not DevTools-protocol interception.** Route interception base64-encodes every body over CDP; moving 8 MB frames that way cost ~1 s each. The server binds 127.0.0.1 on a random port behind a random secret path, and Chromium is launched with `--host-resolver-rules` so the page can't resolve any other host. *Replaces the Phase 2 approach.*

**Uploads are pipelined**: frame N+1 starts drawing while frame N uploads and encodes. Frames reach the encoder strictly in order.

**Video screens and video backgrounds are pre-decoded once** by FFmpeg into JPEG sequences at the scene fps, already fitted (cover/contain/fill, focus, crop, rotation) to the screen's resolution (capped at 1600 px). They're cached by content hash under `.devicewrapper/tmp/clips/` and reused across renders and previews. Each timeline frame maps to a clip frame (`offset`, `loop`), so screen video is frame-exact and deterministic, unlike seeking a `<video>` element.

**Encoders**: MP4 = H.264 High, yuv420p, BT.709, CRF from `quality`, faststart. WebM = VP9 (alpha via `yuva420p` when transparent). MOV = ProRes 4444 (`yuva444p10le` with alpha). All invoked with argument arrays; codec settings come from fixed tables, never from user input.

**Formats that can't hold alpha render opaque.** A scene with a transparent background rendered to MP4 or JPEG renders on black/white with a `NO_ALPHA` warning. Explicitly asking for `transparent: true` with MP4 is an error that names the formats that work.

**Performance fixes found while measuring** (1080p, 2 CPU cores, CPU rendering):
- Soft-shadow blur dominated frame time (~6 s/frame). Shadow-map size now scales with softness, so the same visual blur costs up to 16× less: 6.5 s → 1.3 s/frame at 640×360.
- The 2D compositing canvas is CPU-backed (`willReadFrequently`), since every frame is read back: 4.3 s → 2.7 s at 1080p.
- Loopback HTTP instead of CDP for frame transfer: 2.7 s → 1.9 s.
- Net: about 1.8 s per 1080p frame at 1× supersampling, about 0.9 s at 640×360 with 2×. A 5 s, 30 fps 1080p clip takes about 4–5 minutes on this machine; a desktop CPU with more cores or `DEVICEWRAPPER_RENDER_MODE=fast` will be faster.

**Gradients and the vignette are computed per pixel in JS** with a fixed, position-hashed dither, instead of Canvas2D gradients. Skia dithered gradients differently on the first draw than on later ones (max 1 level, but byte-identical output broke). The replacement is exact, deterministic, and bands less. Layers are cached per size, so video frames reuse them.

**MCP `wait` is capped at 50 s.** MCP clients time out a request after about 60 s, which a `wait: 600` in testing hit. Tool descriptions tell agents to poll `get_render_job { wait: 45 }` for videos and to draft small first.

**The render page is driven over a raw DevTools pipe, not Playwright.** A 150-frame 1080p render showed Node memory growing by one full frame per frame (1.4 GB at frame 120). A heap snapshot traced it to Playwright's network manager, which keeps every request of a page, including POST bodies, alive; Chrome also mirrors each body over the protocol. The renderer now launches the same headless Chromium itself with `--remote-debugging-pipe` and speaks minimal CDP (Target/Runtime/Page only; the Network domain is never enabled). Node memory stays flat (~200 MB) and 1080p frames dropped from ~1.8 s to ~1.2 s. Playwright is still used to install Chromium and locate the binary. *Replaces the earlier Playwright page.*

**Crashes and hangs don't kill renders.** Target crashes fail pending calls immediately; every page call has a deadline; mid-video, a crashed or stuck page is replaced, the scene reloaded, and the frame retried (up to twice). Frames are pure functions of `FrameState`, so a recovered video is frame-identical to a clean one (tested by crashing the page mid-render).

## Phase 4: devices, layouts, styles, motion, templates, compose_scene

**Devices are a union of geometry forms**: `slab` (phones, tablets), `laptop` (base + hinged lid; the node's `lidAngle` is animatable), `monitor` (panel + neck + foot), `watch` (case + crown + looped band). New models: `laptop-14`, `monitor-27`, `watch-45`. Screens, glass, cutouts and glare share one code path across forms. Keyboards are drawn procedurally (canvas texture), so nothing proprietary ships.

**Layouts use real sizes and a shared floor line**, so mixed devices compose correctly (a phone stands next to a laptop, not floating at its center). `showcase` handles mixed sizes; `circle` puts devices in a `carousel` group so the whole ring can turn.

**Styles are data** (`assets/presets/styles.json`): background, lighting preset (+ light overrides), effects, floor, text color and suggested device colors per category. `compose_scene` uses the suggested colors unless a device color is given.

**Motion presets are code, described by data.** They need geometry (device sizes, camera distance, lid defaults), so the keyframes are computed, but every preset is relative to the current pose and deterministic. *Small departure: the plan pictured motions as pure data.* When a property is already animated, `stack: 'auto'` wraps the device in a group and animates the group, so `float` + `rise` both play. The renderer multiplies opacity down the node hierarchy for this.

**`compose_scene` is a pipeline of the same operations the granular tools use** (create → devices → layout → style → text → camera → motion → render defaults), so everything it builds can be refined afterwards. It leaves room for text by shifting the subject in frame (new `frame.shift` on `set_camera`) and adding padding.

**Templates are saved briefs** with `{{screenN}}` slots (`assets/templates/*.json`, plus user templates in `.devicewrapper/templates/`). 15 built-in: hero-phone, hero-laptop, phone-pair, phone-trio, phone-tablet, phone-laptop, floating-phone, device-grid, device-carousel, app-store-hero, dark-product-shot, light-product-shot, watch-hero, desktop-setup, laptop-reveal. There are no separate `create_from_template` / `apply_template` tools: `compose_scene { template, screens, …overrides }` covers both. *Departure from the plan's tool list.*

**Bug found in review: text didn't scale with render size.** Text sizes are canvas pixels, but the page scaled them only by supersampling, so a 640 px preview of a 1920 px scene drew text 3× too large. Now scaled by buffer width / canvas width.

**Soak test passed:** two full 5 s 1080p orbit renders (150 frames each, ~3.5 min each on 2 cores) produced identical frames, with Node memory flat at about 200 MB.

## Phase 5: text and localization

**Texts at the same position stack.** In `compose_scene`, the first text at a position is a headline, later ones are subtitles (smaller, lighter, slightly transparent) placed below it; bottom texts stack upward. The camera shifts the subject further for each extra line.

**Texts animate.** `apply_motion` with a text node ID or `target: 'texts'` supports fade-in/out, rise, drop-in and enter/exit (anchor + opacity), staggered across texts.

**CJK and other scripts come from system fonts, with a warning.** Noto CJK packages are 50–80 MB each, too heavy to bundle. The bundled Inter covers Latin, Cyrillic, Greek and Vietnamese; anything else falls back to the machine's fonts (macOS ships CJK fonts; the Docker image adds Noto CJK and emoji). Validation warns `SYSTEM_FONT_FALLBACK` per locale because such text can look different on another machine, and points to importing a font asset for exact results. Verified: one `render` call with `locales: [en, es, fr, de, ja]` produced five MP4s with correct Japanese glyphs.

**CLI `--locales en,es,ja`** renders one file per locale (`-<locale>` suffix, or `{locale}` in the output path).

### Known limitations after Phase 4

- Bloom and depth of field are accepted in the scene format but not drawn yet; validation warns `NOT_RENDERED`.
- Videos render on one page at a time; spreading frames across pages would help on many-core machines.
- The first render after the server starts takes about 10–20 s (Chromium start, shader compile, texture upload).
- CJK and other non-Latin scripts beyond Latin/Cyrillic/Greek/Vietnamese need a font asset (import a TTF/OTF and use its asset ID as `font`).
