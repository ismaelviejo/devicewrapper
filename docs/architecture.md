# Architecture

## Packages

```
packages/
  schema/    Zod schemas: scene, devices. Types + JSON Schema. No logic.
  core/      Everything about scenes that isn't pixels. Pure functions, no Three.js, no browser.
  renderer/  RenderBackend implementation: Three.js page in headless Chromium, textures, FFmpeg.
  jobs/      Engine facade (workspace + store + devices + backend) and the render job queue.
  mcp/       The MCP server: tools, resources, guide. Thin adapters over core and jobs.
  cli/       `devicewrapper` command: mcp, render, validate, scenes, devices, setup.
```

Dependencies only point one way:

```
schema ◄── core ◄── renderer ◄──┐
                ◄── jobs ◄───────┼── mcp ◄── cli
                                 └──────────── cli
```

`mcp` and `cli` never import Three.js. The `RenderBackend` interface lives in core, so the engine, the MCP server and the tests can run without a renderer (rendering tools then return `NOT_IMPLEMENTED`), and another backend (Blender, a GPU server) could be dropped in.

## core, module by module

| Module | Does |
|---|---|
| `canonical`, `ids` | Canonical JSON (sorted keys) and hashing; deterministic ID allocation |
| `ops` | Pure scene operations: `createScene`, `addNode`, `updateNode`, `setCamera`, `setLights`, `setTrack`, … Each is `(scene, options) → scene` and validates its input |
| `validate` | Full scene validation with codes, paths and hints |
| `timeline` | `evaluateFrame(scene, frame)` → `FrameState`: every animated value at that frame |
| `properties` | The table of animatable properties and their value kinds |
| `bounds` | Real device sizes, world-space bounds, and camera framing (`frameTargets`) |
| `devices` | Device registry: built-in and workspace definitions, color variants |
| `presets` | Lighting and shot presets from data files |
| `layout`, `style`, `motion`, `compose` | The high-level layer: arrangements, looks, animation presets, briefs and templates |
| `workspace`, `store`, `assets` | Config, path security, the scene store, asset import and probing |
| `render` | The `RenderBackend` interface and render request resolution |

Data (device models, presets, styles, templates) lives in `packages/core/assets/` as JSON, never in handlers.

## Data flow for one MCP call

```
agent ─► mcp tool handler: Zod-validate args
           └► core op: (scene, options) → scene'   (pure; throws DwError with code/path/hint)
                └► store.save(scene')             (canonical JSON in .devicewrapper/scenes)
           ◄─ summary + validation issues          (JSON text; errors as isError results)
```

For `render`:

```
mcp render ─► jobs.create(request) ─► job record (persisted) ─► queue (N concurrent)
                                              │
                            backend.render: validate ─► resolve assets ─► for each frame:
                                core.evaluateFrame ─► page draws FrameState ─► pixels ─► sharp / FFmpeg
```

Jobs snapshot the scene when they're created, so editing a scene doesn't change a render in progress. Job records survive restarts; a job that was running when the server stopped is marked `INTERRUPTED`.

## Design rules

These are enforced by review and tests (see [CLAUDE.md](../CLAUDE.md)):

- The Zod schemas are the single source of truth for the scene format. Tool schemas reuse them.
- Scene operations are pure. MCP handlers stay thin: validate, call core, format.
- All animation and timeline math runs in Node. The renderer only draws a given `FrameState`.
- No `Math.random`, `Date.now` or random UUIDs in anything that affects scene data or pixels.
- Paths go through `realpath` and must be inside the workspace or an allowed root.
- FFmpeg runs with argument arrays built from enums; never a shell string.
- Nothing supplied through MCP is executed: no code, shaders or scripts.
- Every error names the exact thing at fault and suggests a fix.

## Tests

| Suite | What it covers |
|---|---|
| `tests/unit` (fast, no browser) | Schema, canonical round-trips, every op, validation cases, timeline and easing math, framing, layouts, styles, motions, compose and templates, workspace security, the MCP surface (tool list snapshot, full workflows through an in-memory client) |
| `tests/golden` (renders) | Small renders compared pixel by pixel with references in `tests/golden/reference/`: devices, text and locales, transparency, video frames, lid animation, DOF, bloom, the mirror floor, crash recovery. Update references deliberately with `pnpm test:golden:update` and look at them |
| [Agent eval](eval.md) | Real agents working only from the tool docs, scored on the results |
