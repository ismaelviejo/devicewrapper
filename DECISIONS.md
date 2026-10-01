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

## Phase 6: look development

**Depth of field and bloom are real post passes, not approximations in 2D.** After the main render the page copies the framebuffer, renders a cheap depth-only pass (glare layers, reflections and nearly invisible meshes hidden so they don't occlude), and runs a fixed-kernel gather shader that blurs by circle of confusion (focus on the camera target unless `focusDistance` is set; `aperture` 0..1 scales the blur). Everything is fixed-tap and noise-free, so frames stay deterministic. Image backgrounds are blurred in the 2D layer to match when DOF is on (gradients are already smooth). Bloom: soft-knee bright pass, two blur levels at quarter resolution, additive. The first version used a hard threshold and looked blown out on screens; the soft knee fixed it.

**Reflective floor = `material: { type: 'reflective' }` on a plane.** Built on Three's `Reflector` with our own shader: the mirror image is rendered at half resolution into a transparent target, blurred with a 25-tap Gaussian over a matching mip level (the first 25-tap version without mips showed ghost copies), and drawn with alpha = coverage × strength × fade, so it sits over any background, including gradients and transparent PNGs. A shadow-catcher layer on top keeps the contact shadow. Fade is computed per frame from the devices' height and the camera elevation, so "reflection fades out halfway up the device" holds for any shot without tuning. On primitives the material degrades to a shadow catcher with a warning.

**Two procedural environments.** `softbox` (near-black room with strip lights: graphic highlights on glass and dark metal) and `sunset` (warm low sun, blue sky). Built from emissive panels and prefiltered with PMREM like the existing `studio`, so no HDR files ship. Styles can now set the environment; `sunset` uses it, and two new styles use the reflective floor: `glossy-dark` (softbox) and `glossy-light`.

**Floor specs share one schema.** `FloorSpecSchema` (none, shadow, solid, reflective) is exported from core and used by styles and `apply_style`, so the MCP tool can't drift from the data files.

## Phase 7: hardening and docs

**Tool docs are generated from the live server** (`pnpm run docs:gen` → `docs/tools.md`, `docs/resources.md`), so they can't drift from the Zod schemas and descriptions.

**Tool-description eval with real agents.** Two agents that read only the generated docs completed eight design briefs through the tools; their reports drove a round of fixes (see [docs/eval.md](docs/eval.md)). The biggest were real rendering bugs the golden tests couldn't catch because the references were produced by the same code: DOF bleeding the background over the in-focus subject, and a white sweep across black display glass on light styles.

**Framing re-centers on the picture, not the 3D box.** With perspective, a device near the camera looks bigger, so centering the bounding box left compositions lopsided. `frameTargets` now re-centers on the projected extents (converges in a few rounds, deterministic). This changed several golden references on purpose.

**`target: 'all'` for motions** groups the top-level devices under an `arrangement` group (created once, positions and existing position tracks converted to group space) so a fan or row can turn as one.

**Docs.** `docs/` has hand-written guides (using it in other projects, scene format, templates and custom devices, rendering, architecture) and generated references (tools, resources, catalog). CI fails if the generated docs are stale. Every code sample in the guides was run: the scene-format example validates and renders, the custom template and device examples load and render, the library snippet renders. The example gallery is rendered by `scripts/gen-examples.mjs` from the briefs shown next to each image.

**Reflection fade uses the real mirror geometry.** The first version assumed the reflection of height h lands h / tan(elevation) in front of the object, which is only true for a high camera; with a low camera the fade barely started. It now uses the exact crossing point D·h / (Hc + h), and the framing keeps the same visible fraction.

**CI had been red since Phase 4, on the crash-recovery test only.** The golden renders pass on GitHub's runners (so determinism holds across machines). The crash test failed because the page sometimes crashed between calls, while no request was pending: the crash event was seen but nothing was waiting for it, and the next call to the dead page hung until the 180 s deadline. Crashed sessions are now remembered so later calls fail at once, `Inspector.targetCrashed` is handled as well as `Target.targetCrashed`, and a crash while loading the scene gets one retry like a crash during a frame. On GitHub's runners a forced crash sent no crash event at all and the page just hung, so the browser now runs without the crash reporter, and the frame hang timeout is configurable (`frameTimeoutMs`; the golden tests use 45 s instead of 180 s). CI is green again. `DW_CDP_TRACE=1` logs DevTools events for debugging this kind of thing.

**npm publishing is ready but not done:** there are no npm credentials in this environment. The packages build with correct `files`/`exports`; see the README for publishing and for using the server from other projects without publishing.

### Known limitations after Phase 6

- Reflections show only the 3D scene, not the background, and there is no real roughness-based blur that grows with distance (blur is uniform).
- The default shots frame the devices, not their reflection; add camera `padding` (≈0.3) to include it.
- Videos render on one page at a time; spreading frames across pages would help on many-core machines.
- The first render after the server starts takes about 10–20 s (Chromium start, shader compile, texture upload).
- Scripts outside Latin/Cyrillic/Greek/Vietnamese use system fonts (warned `SYSTEM_FONT_FALLBACK`); import a TTF/OTF asset for identical output across machines.

## After v1: saved compositions, motion clips, screen-relative camera moves

Asked for by real use: a fast "rhythm" reel (spin reveal, camera slamming in to one spot of the screen, pull-out for the headline, punch back in, on a 120 BPM grid) was built from hand-made keyframes, and the user wanted to reuse its motion with other projects' screenshots. Briefs couldn't hold that.

**Templates gained two kinds, alongside `brief`.** `scene` is a whole scene with device screens turned into `{{screenN}}` slots and text into `{{variables}}`; `motion` is one movement cut out of a scene. A template file holds exactly one of `brief`, `scene` or `motion`. `save_template` writes them, so the user never edits JSON. *Departure from PLAN.md §6, which kept templates to briefs.*

**Motion clips are stored relative to the device.** Camera points in the device's base frame, in units of its screen height; device position and rotation as offsets from its base pose. That makes a clip independent of where the device stands and how big it is. Euler offsets are exact for the usual turns around Y and approximate for compound rotations. Cutting a window out of a track copies whole segments with their easing, and bakes a segment the window cuts through (or a spline) at 30 samples per second, so the replay matches.

**Clips and the new camera moves splice instead of replacing.** Each changes only its own time window on a track, so several can be chained on one timeline. `focus` and `reframe` are defined by what the camera should see on arrival, computed from the devices' animated pose at that moment (`worldPose`, `posedScene`). `focus` aims at a normalized point of the display and sizes the view as a fraction of the screen height, so it works on any screenshot and device (laptop lids included). With several devices and no target it picks the one nearest the camera's aim, so every preset still works without options.

**A global template folder** (`~/.devicewrapper/templates`, configurable) is shared by all workspaces; project templates override it, and it overrides built-ins. Tests point it at a temp folder. It is written only by `save_template`, with names restricted to IDs; it is not added to the general read/write roots.

**Save only on request.** The server instructions tell agents to offer a review of every candidate movement after a finished composition and to save only what the user picks.

