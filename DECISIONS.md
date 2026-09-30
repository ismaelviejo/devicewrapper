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

### Known limitations after Phase 2

- Video (mp4/webm/mov), video screens and video backgrounds are Phase 3. Validation warns `NOT_RENDERED` and render refuses video formats with a clear message.
- Bloom and depth of field are accepted in the scene format but not drawn yet; validation warns.
- Device models: `phone-modern`, `phone-classic`, `tablet`. Laptop, monitor and watch are Phase 4.
- Deterministic mode is CPU-bound: expect ~4–6 s per 1080p still with 2× supersampling on a small machine, and ~12 s for the first render while Chromium starts.
