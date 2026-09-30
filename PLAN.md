# DeviceWrapper — Build Plan

A headless 3D device-mockup engine driven entirely through MCP, reusable across projects.

Repo: `github.com/ismaelviejo/devicewrapper` (empty as of 2026-09-30, so this is a greenfield standalone package).

---

## 0. What this plan changes from the original brief

The original brief is solid on scope. Its weak points are the parts that decide whether the tool actually works in agent loops and renders reliably. These are the decisions this plan makes up front:

| Topic | Original brief | This plan | Why |
|---|---|---|---|
| Headless renderer | "Three.js, headless" | Three.js in **headless Chromium (Playwright)**, behind a `Renderer` interface. Optional **Blender** backend later for hero-quality output | `headless-gl` is WebGL1-only, and current Three.js has dropped WebGL1. Headless Chromium is the only dependable way to run modern Three.js server-side. It is a render worker, not a UI |
| Determinism | "as deterministic as possible" | Render with **SwiftShader (CPU WebGL)** by default, pin Chromium + Three.js versions, no `requestAnimationFrame`, time = `frame / fps`, IDs never random | GPU drivers produce different pixels on different machines. CPU rasterization gives the same pixels everywhere, including CI |
| Screen video sync | "must stay synchronized" | Pre-decode screen videos with FFmpeg to frames at the scene fps and bind frame *N* as the texture | Seeking `<video>` elements per frame is unreliable and non-deterministic |
| Video encoding | FFmpeg | Stream raw frames into FFmpeg over stdin (`image2pipe`). No frame buffering in memory | 4K × 60fps × 10s would otherwise be ~30 GB of RGBA |
| MCP tool count | ~70 tools | **~25 tools**, patch-style (`update_device` with a partial object) | Large tool lists bloat agent context and hurt tool selection. `set_device_transform`, `set_device_material`, etc. collapse into one `update_device` |
| Render vs export tools | `render_*`, `export_*`, `create_render_job` overlap | One job system: `render` creates a job, `get_render_job` polls it | Three names for the same thing confuses agents |
| Agent feedback | `render_preview` returns a path | `render_preview` returns an **inline image** in the MCP result | The agent can *see* the result and correct it. This is the single biggest quality lever |
| Build order | Vertical slice first | **Scene model + MCP first (no pixels)**, then the render slice | Matches your closing note: the MCP + scene JSON contract is the reusable asset. The renderer can then evolve without breaking clients |
| Scope | Rain, snow, 3D text, spline paths, motion blur in v1 | Deferred to later phases (listed in §9) | Keep v1 shippable |
| Naming | `mockpose-mcp` | `devicewrapper` CLI and packages; generic device names (`phone-modern`, not "iPhone") | Avoid trademark issues with Mockpose and Apple |

---

## 1. How you'll use it from other projects

Three entry points, one engine:

1. **MCP server (primary)**, over stdio, launched per project. In Claude Code, either add it once for all your projects:
   ```bash
   claude mcp add --scope user devicewrapper -- npx -y devicewrapper mcp
   ```
   or commit a `.mcp.json` in a specific project so it's always available there:
   ```json
   {
     "mcpServers": {
       "devicewrapper": {
         "command": "npx",
         "args": ["-y", "devicewrapper", "mcp"],
         "env": { "DEVICEWRAPPER_WORKSPACE": "." }
       }
     }
   }
   ```
   While developing devicewrapper itself, point at the local build instead: `claude mcp add devicewrapper-dev -- node /path/to/devicewrapper/packages/cli/dist/index.js mcp`. Any other MCP client (Codex, Claude Desktop) works with the same command.
2. **CLI**: `devicewrapper render scene.json -o out.mp4`
3. **Library**: `import { createScene, render } from "@devicewrapper/core"`

**Per-project workspace.** Each consuming project gets a `.devicewrapper/` folder holding its scenes, imported assets, and outputs. The server only reads and writes inside that workspace (plus a read-only built-in templates/devices directory). This keeps projects isolated and makes paths in scene JSON relative and portable.

```
my-app/
  .devicewrapper/
    config.json        # optional overrides
    scenes/*.json
    assets/            # imported screenshots, videos, models
    output/
```

Later: a Streamable HTTP transport so one long-running server (with a warm Chromium pool) can serve several projects.

---

## 2. Architecture

pnpm monorepo. Package boundaries enforce the "core works without MCP" rule.

```
devicewrapper/
  packages/
    schema/        # Zod schemas = source of truth. Exports types + JSON Schema
    core/          # Pure scene ops, timeline eval, compositions, templates, validation, localization
    renderer/      # Renderer interface + ThreeChromiumRenderer (Playwright + Three.js page bundle)
    media/         # FFmpeg wrappers, video pre-decode, image processing (sharp), asset probing
    jobs/          # Render job queue, persistence, progress, cancellation
    mcp/           # MCP server: tools, resources, prompts. Thin adapters over core/jobs
    cli/           # devicewrapper CLI (validate, render, mcp, templates)
  assets/
    devices/       # Data-driven device definitions (JSON) + optional CC0 GLBs
    templates/     # Template scene JSON files
    fonts/         # Bundled open-license fonts (Inter, etc.)
    hdri/          # CC0 environment maps (Poly Haven)
  docs/
  tests/golden/
  docker/          # Pinned Chromium + FFmpeg image for reproducible renders
```

Dependency direction: `schema ← core ← (renderer, media, jobs) ← mcp, cli`. MCP and CLI never touch Three.js directly.

### Render pipeline

```
Scene JSON ──► core.resolve()            # apply template, locale vars, defaults → ResolvedScene
          ──► core.evaluate(t)           # timeline sampled at t → FrameState (plain data)
          ──► renderer.renderFrame()     # Chromium page builds/updates Three.js scene from FrameState
          ──► PNG bytes ──► sharp (still) | FFmpeg stdin (video)
```

Key point: **all animation math happens in Node (`core`)**, not in the browser. The browser page is a dumb "draw this FrameState" function. That keeps the timeline testable without a renderer and keeps the renderer swappable (Blender backend consumes the same `FrameState`).

---

## 3. Canonical scene model

Zod schemas in `packages/schema`, exported as TypeScript types and JSON Schema (served to agents as an MCP resource).

```jsonc
{
  "schemaVersion": 1,
  "id": "hero-fitness",
  "seed": 42,
  "canvas": { "width": 1920, "height": 1080, "fps": 60, "duration": 5 },
  "background": { "type": "gradient", "kind": "radial", "stops": [["#1a1a2e", 0], ["#000", 1]] },
  "environment": { "preset": "studio-soft", "intensity": 1 },
  "camera": { "type": "perspective", "position": [0, 0.2, 3], "target": [0, 0, 0], "fov": 35, "dof": null },
  "lights": [ { "id": "key", "type": "directional", "position": [2, 3, 2], "intensity": 2.5, "castShadow": true } ],
  "nodes": [
    { "id": "phone", "kind": "device", "model": "phone-modern", "color": "black",
      "transform": { "position": [0, 0, 0], "rotation": [0, -15, 0], "scale": 1 },
      "screen": { "source": { "type": "image", "asset": "fitness" }, "fit": "cover", "glare": 0.3 } },
    { "id": "floor", "kind": "plane", "material": "floor-matte", "transform": { "position": [0, -1, 0] } },
    { "id": "title", "kind": "text2d", "content": "{{headline}}", "font": "Inter", "size": 72 }
  ],
  "materials": { "floor-matte": { "type": "pbr", "color": "#111", "roughness": 0.9 } },
  "assets": { "fitness": { "type": "image", "path": "assets/fitness.png", "hash": "sha256:…" } },
  "animation": {
    "tracks": [
      { "target": "phone", "property": "transform.rotation", "keyframes": [
        { "t": 0, "value": [0, -15, 0] }, { "t": 5, "value": [0, 15, 0], "easing": "easeInOutCubic" } ] },
      { "target": "camera", "property": "position", "keyframes": [ … ] }
    ]
  },
  "effects": [ { "type": "vignette", "strength": 0.3 } ],
  "variables": { "headline": "Train smarter" },
  "locales": { "es": { "headline": "Entrena mejor" } },
  "render": { "format": "mp4", "quality": "high", "transparent": false, "supersample": 2 }
}
```

Decisions:

- **Single `nodes` array with a `kind` discriminator** (device, plane, primitive, group, text2d, model) rather than separate `devices`/`objects`/`text` arrays. One ID namespace, one transform system, groups via `parent`. Tools like `add_device` still exist; they just create nodes of kind `device`.
- **Rotations stored as Euler degrees** (agent-friendly); interpolated internally as quaternions (slerp).
- **Track paths** (`"transform.rotation"`, `"material.opacity"`) validated against the target's schema, so bad paths fail at validation, not render.
- **IDs are agent-supplied or derived deterministically** (`phone`, `phone-2`, …). No random UUIDs anywhere in scene data.
- **Canonical JSON serialization** (sorted keys, normalized numbers) so the same scene hashes identically. The hash doubles as a render cache key.
- **`schemaVersion` + migrations** from day one.
- Scene operations are **pure functions** `(scene, op) → scene`. Every MCP mutation is an op, which gives undo/redo and an audit log for free.

---

## 4. Devices

Data-driven JSON definitions in `assets/devices/`:

```jsonc
{
  "id": "phone-modern",
  "category": "smartphone",
  "body": { "width": 0.0716, "height": 0.1476, "depth": 0.0078, "cornerRadius": 0.011, "edge": "flat" },
  "screen": { "inset": 0.0012, "cornerRadius": 0.0095, "aspect": "19.5:9", "island": { "width": 0.021, "height": 0.006 } },
  "cameraBump": { "position": [0.018, 0.058], "size": [0.028, 0.028], "lenses": 3 },
  "buttons": [ … ],
  "colors": { "black": "#1c1c1e", "silver": "#e3e4e5", "blue": "#2c3e50" }
}
```

- v1 models, all **procedural** (rounded-rect extrude + inset screen + details): `phone-modern`, `phone-classic`, `tablet`, `laptop` (hinged lid, animatable open angle), `monitor`, `watch`.
- Optional GLB override per definition for higher-fidelity CC0 models later. Never ship proprietary Mockpose or Apple assets.
- Real-world dimensions in meters so compositions and camera framing math are physically consistent.

**Screen content**: image (PNG/JPEG/WebP), SVG (rasterized with sharp at screen resolution × supersample), video (pre-decoded frames), solid color. Options: `fit` (cover/contain/fill), `crop`, `rotation`, `brightness`, `glare`, and the rounded mask from the device definition. Screen is an emissive material so it isn't darkened by scene lighting.

---

## 5. MCP surface (~25 tools)

Every tool: strict Zod input schema, defaults, a description written for agents (what it does, when to use it, one example), and structured errors.

**Scene**
- `create_scene` — blank or `fromTemplate`, canvas settings
- `get_scene` — full JSON or a compact summary (default summary, to save agent context)
- `list_scenes`, `duplicate_scene`, `delete_scene`
- `validate_scene` — machine-readable issues list
- `import_scene` / `export_scene` — raw JSON in/out

**Composition (high level)**
- `compose_scene` — declarative brief → deterministic scene (see §6)
- `apply_layout` — arrange existing devices: hero, pair, trio, row, grid, stack, fan, arc, orbit, cluster
- `apply_style` — background + lighting + environment preset in one call (dark-studio, light-studio, soft-gradient, sunset, product)

**Nodes**
- `add_device`, `add_node` (plane, primitive, group, text2d, model)
- `update_node` — partial patch: transform, material, screen, visibility, shadows, parent
- `remove_node`, `list_nodes`

**Camera & lighting**
- `set_camera` — patch, plus helpers `frame: ["phone"]` (auto-fit targets) and `shot: "hero" | "closeup" | "wide" | "top-down"`
- `set_lights` — replace or patch lights, or `preset: "studio"`

**Background & effects**
- `set_background` — solid, gradient, image, video, transparent, procedural
- `set_effects` — patch the effects list

**Animation**
- `set_track` — upsert keyframes for one target/property
- `remove_track`
- `apply_motion` — preset motions on a node or camera: slow-orbit, float, enter-left, exit-right, push-in, turntable, rise

**Assets**
- `import_asset` — path inside workspace (or URL later), probes dimensions/duration, hashes
- `list_assets`

**Localization**
- `set_variables` — base variables and/or per-locale dictionaries

**Rendering (all async jobs)**
- `render_preview` — small, fast, single frame at time *t*. **Returns the image inline** plus the path. Short timeout, runs synchronously
- `render` — still or video, format, resolution preset or explicit size, locales list → returns `jobId`(s)
- `get_render_job`, `list_render_jobs`, `cancel_render_job`

**MCP resources**
- `devicewrapper://schema/scene` — JSON Schema
- `devicewrapper://scenes/{id}`
- `devicewrapper://templates` and `devicewrapper://templates/{id}`
- `devicewrapper://devices` — models, colors, dimensions
- `devicewrapper://presets` — layouts, styles, motions, lighting

**MCP prompts** (optional, for clients that surface them): `app-store-hero`, `product-video`, `localized-screenshots`.

### Error shape

```json
{
  "code": "ASSET_NOT_FOUND",
  "message": "Node 'phone' screen references asset 'fitness', path 'assets/fitness.png' does not exist in workspace /Users/isma/my-app/.devicewrapper.",
  "path": "nodes[0].screen.source.asset",
  "hint": "Call import_asset with the screenshot path first, or list_assets to see available IDs."
}
```

Returned as `isError: true` tool results so the agent sees and fixes them rather than the call throwing.

---

## 6. `compose_scene` and templates

`compose_scene` accepts a structured brief (no natural language parsing, no LLM inside the engine):

```json
{
  "devices": [ { "model": "phone-modern", "color": "black", "screen": "assets/fitness.png" } ],
  "layout": "hero",
  "style": "dark-studio",
  "camera": { "shot": "hero" },
  "motion": { "preset": "slow-orbit", "duration": 5 },
  "text": [ { "content": "{{headline}}", "position": "top" } ],
  "canvas": { "preset": "1080p", "fps": 30 }
}
```

It is a pipeline of the same pure functions the granular tools call: `createScene → addDevice×n → applyLayout → applyStyle → frameCamera → applyMotion`. So anything `compose_scene` produces can be refined with the low-level tools, and the output is deterministic for a given brief.

**Templates** are plain scene JSON files in `assets/templates/` with placeholder slots (`{{screen1}}`, `{{headline}}`). v1 set: hero-phone, hero-laptop, phone-pair, phone-trio, phone-tablet, phone-laptop, floating-phone, device-grid, app-store-hero, dark-product-shot, light-product-shot. Users can drop their own templates in `.devicewrapper/templates/`.

---

## 7. Rendering details

**Renderer interface**
```ts
interface Renderer {
  init(opts): Promise<void>
  load(scene: ResolvedScene): Promise<void>          // upload geometry, textures once
  renderFrame(state: FrameState): Promise<Buffer>    // RGBA or PNG
  dispose(): Promise<void>
}
```

**ThreeChromiumRenderer**
- Playwright launches Chromium with `--use-angle=swiftshader` (deterministic) or GPU flags (`quality: "fast"`).
- A prebuilt page bundle (Vite) contains Three.js and a scene builder. Node sends `FrameState` via `page.evaluate`, reads pixels via `readPixels` → transferred as binary.
- Page pool sized by `MAX_CONCURRENT_RENDERS`, pages reused across jobs.
- Supersampling: render at 2× and downscale with sharp (lanczos3).
- Shadows: PCF soft shadows + contact shadow plane. AO: N8AO / SSAO pass. Bloom, vignette, DoF (BokehPass): `postprocessing` library. Reflections: environment-map reflections + optional reflective floor.
- Transparent background: `alpha: true`, premultiplied handling checked in golden tests.

**Video**
- Frames streamed to FFmpeg stdin; FFmpeg spawned with an argument array (never a shell string).
- Outputs: MP4 H.264 (`yuv420p`, CRF presets), WebM VP9, **WebM VP9 alpha** (`yuva420p`), **ProRes 4444** (`prores_ks`, `yuva444p10le`) for transparent video.
- Screen and background videos pre-decoded to frame sequences in the temp dir at scene fps, cached by asset hash.

**Localization renders**: `render` with `locales: ["en","es","fr"]` creates one job per locale → `output/<scene>/<locale>.mp4`. Geometry and textures loaded once, only text layers change per locale.

**Jobs**
- In-process queue (p-queue) with configurable concurrency.
- Job records persisted as JSON in `.devicewrapper/jobs/` so status survives an MCP server restart (a restarted server marks interrupted jobs `failed` with a clear reason).
- Progress = frames done / total. Cancellation kills the FFmpeg process and releases the page.

**Optional later: Blender backend.** You already run Blender locally. A `BlenderRenderer` that consumes the same `FrameState` and renders with Cycles gives true path-traced reflections, AO, DoF and motion blur for hero shots. Out of scope for v1, but the interface is designed for it.

---

## 8. Configuration and security

`.env.example` / `.devicewrapper/config.json`:
```
DEVICEWRAPPER_WORKSPACE=.
DEVICEWRAPPER_OUTPUT_DIR=.devicewrapper/output
DEVICEWRAPPER_TMP_DIR=
DEVICEWRAPPER_FFMPEG_PATH=ffmpeg
DEVICEWRAPPER_CHROMIUM_PATH=            # default: Playwright's bundled Chromium
DEVICEWRAPPER_RENDER_MODE=deterministic # or "fast" (GPU)
DEVICEWRAPPER_MAX_CONCURRENT_RENDERS=2
DEVICEWRAPPER_MAX_RESOLUTION=7680x4320
DEVICEWRAPPER_MAX_DURATION_SECONDS=120
```

Security rules:
- Every path resolved with `realpath` and checked against allowlisted roots (workspace + built-in assets). Symlinks escaping the root rejected.
- Asset imports: extension and magic-byte checks, size limits, probe with ffprobe/sharp before accepting.
- No shell execution; FFmpeg and ffprobe via `execa` with argument arrays; enum-only codec/format values.
- No user-supplied code, shaders or scripts executed. Chromium page loads only the local bundle, with network disabled.
- Resolution, duration and fps capped by config.

---

## 9. Phases

Each phase ends with `pnpm build && pnpm typecheck && pnpm test` green before moving on.

### Phase 1 — Contract: schema + core + MCP, no pixels
- Monorepo scaffold (pnpm, TypeScript strict, Vitest, ESLint, Changesets).
- `schema`: full Zod scene model, JSON Schema export, `schemaVersion` + migration hook.
- `core`: pure ops (add/update/remove nodes, camera, lights, background, tracks), canonical serialization + hash, validation with structured issues, timeline evaluation (linear, ease-*, cubic Bézier, slerp).
- Workspace store (scenes as JSON files, path safety).
- `mcp`: stdio server with all scene/node/camera/light/animation/asset tools and resources. `render_*` tools registered but returning `NOT_IMPLEMENTED` with a clear message.
- **Done when:** Claude Code can connect to the local build, build a scene through tools, `validate_scene` it, and round-trip it through `export_scene`/`import_scene` byte-identically. Timeline evaluation has unit tests.

### Phase 2 — Vertical slice: one phone to PNG
- `renderer`: Playwright + Three.js page bundle, SwiftShader mode.
- Procedural `phone-modern`, image screen texture with rounded mask, one directional + ambient light, solid/gradient background.
- `render_preview` returning an inline image; `render` for PNG as a job.
- CLI: `devicewrapper validate`, `devicewrapper render scene.json -o out.png`, `devicewrapper mcp`.
- Docker image with pinned Chromium + FFmpeg.
- **Done when:** `MCP → create_scene → add_device → import_asset → update_node(screen) → set_camera → set_lights → render_preview → render PNG → path returned` works end-to-end, and a golden-image test passes in CI.

### Phase 3 — Animation + video
- FrameState streaming, FFmpeg MP4/WebM, progress and cancellation.
- Screen video pre-decode + sync; background video.
- Transparent PNG, WebM alpha, ProRes 4444.
- **Done when:** a 5s 1080p orbit renders deterministically (two runs produce identical frame hashes in deterministic mode).

### Phase 4 — Devices, layouts, styles, compose_scene
- Remaining device models (tablet, laptop with hinge, monitor, watch, phone-classic).
- `apply_layout`, `apply_style`, `apply_motion`, camera `frame`/`shot` helpers.
- `compose_scene`, templates, user templates dir.
- **Done when:** both example briefs from the original spec (§29 there) work via a single `compose_scene` call plus at most a few refinement calls.

### Phase 5 — Text + localization
- `text2d` nodes rendered via canvas-texture overlay; bundled fonts; missing-font validation.
- Variables, locale dictionaries, multi-locale render jobs.
- **Done when:** one scene renders `en/es/fr/de/ja` MP4s in one `render` call, with correct CJK glyphs.

### Phase 6 — Look development
- PBR device materials (anodized, glass back, matte), HDRI environments, contact shadows, reflective floors.
- Effects: bloom, DoF, AO, vignette, glow, fog.
- Lighting presets: studio, soft-studio, dramatic, dark, bright, sunset, product.
- **Done when:** the template set looks portfolio-grade. (This is where your design eye matters most. Budget iteration time here.)

### Phase 7 — Hardening + docs
- Full docs (`architecture`, `scene-format`, `mcp`, `tools`, `rendering`, `templates`, `examples`), each tool documented with an example call.
- Tool-description eval: script a set of briefs, run them through an agent, check the resulting scenes validate and render.
- npm publish (`devicewrapper`, `@devicewrapper/*`).

### Later (explicitly deferred)
Particles (rain/snow/dust), 3D extruded text, spline camera paths, motion blur (sub-frame accumulation), Blender backend, HTTP transport + shared render server, object-storage asset backend, GLB device imports from CC0 libraries.

---

## 10. Testing strategy

- **Unit (core):** ops, serialization round-trip, canonical hashing, validation cases (missing assets, bad IDs, bad track paths, invalid resolutions, malformed locale vars), easing/slerp math, layout math.
- **MCP:** schema snapshot tests for every tool (catches accidental contract changes), in-memory client tests executing full workflows.
- **Golden renders:** small (320×180) frames rendered in deterministic mode, compared with `pixelmatch` at a tight tolerance. Stored in `tests/golden/`, updated only with an explicit flag.
- **Jobs:** lifecycle (queued → running → completed/failed/cancelled), restart recovery, concurrency limit.
- **CI:** GitHub Actions running inside the pinned Docker image.

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| SwiftShader is slow for 4K video | `fast` GPU mode for drafts; deterministic mode for finals; parallel page pool; later Blender or GPU server |
| Procedural devices look generic | Invest in Phase 6 materials/lighting; GLB override slot for better models |
| Chromium + FFmpeg install friction in other projects | `npx` pulls Playwright Chromium automatically; Docker image; clear error if FFmpeg missing |
| Agents misuse tools | Rich descriptions with examples, `render_preview` visual feedback, compact `get_scene` summaries, validation hints |
| stdio server dies with the client mid-render | Persisted job records; later a standalone HTTP render server |

---

## 12. Building it with Claude Code

Commit `PLAN.md` and `CLAUDE.md` to the repo root. `CLAUDE.md` is loaded automatically in every Claude Code session, so the build rules (phase discipline, determinism, package boundaries) apply across sessions without repeating them.

Work one phase per session (or a few sessions per phase). Start each in plan mode so you approve the approach before files are written.

**Phase 1 kickoff prompt:**

> Read `PLAN.md` and `CLAUDE.md`. Implement **Phase 1 only**. Scaffold the pnpm monorepo exactly as in §2, implement `schema`, `core`, the workspace store, and the MCP server with the tools in §5 (render tools stubbed with `NOT_IMPLEMENTED`). Follow the determinism rules in §3. Run build, typecheck and tests before finishing. Then register the local build with `claude mcp add devicewrapper-dev` and exercise it by building one scene through the tools. Report: files created, how to start the server, three example tool-call sequences, and anything in the plan you think should change before Phase 2.

**Later phases:** "Read `PLAN.md`. Phase N is next; Phases 1–(N-1) are done. Implement Phase N and meet its Done-when criteria."

**Dogfooding:** from Phase 2 on, keep the dev server registered so Claude Code can call `render_preview` on its own output while it works, and look at the images itself.
