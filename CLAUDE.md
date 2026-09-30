# devicewrapper

Headless 3D device-mockup engine controlled through MCP. `PLAN.md` is the source of truth for scope, architecture and phase order. Read it before starting any task.

## Working rules

- Work on one phase at a time, in the order in `PLAN.md` §9. Don't start features from a later phase.
- A phase is finished only when its "Done when" criteria pass and `pnpm build && pnpm typecheck && pnpm test` is green.
- No placeholder implementations for core behavior. If something can't be done properly yet, stub it with a clear `NOT_IMPLEMENTED` error and note it in the phase report.
- If the plan turns out to be wrong, say so and propose the change instead of quietly diverging.

## Architecture rules

- Dependency direction: `schema ← core ← (renderer, media, jobs) ← mcp, cli`. `mcp` and `cli` never import Three.js.
- Zod schemas in `packages/schema` are the single source of truth for scene types.
- Scene operations are pure functions `(scene, op) → scene`. MCP handlers stay thin: validate input, call core, format the result.
- All animation and timeline math runs in Node (`core`). The renderer only draws a given `FrameState`.
- Templates, device definitions and presets are data files in `assets/`, never hardcoded in handlers.

## Determinism

- No `Math.random`, `Date.now` or random UUIDs in anything that affects scene data or pixels. Use the scene `seed` and deterministic IDs.
- Time for a frame is always `frame / fps`. No `requestAnimationFrame`.
- Scene JSON serializes canonically (sorted keys) so identical scenes hash identically.

## Security

- Resolve every path with `realpath` and check it is inside the workspace or the built-in assets directory.
- Run FFmpeg/ffprobe with argument arrays, never a shell string. Codec and format values come from enums.
- Never execute code, shaders or scripts supplied through MCP.

## MCP tool conventions

- Every tool has a strict Zod schema, sensible defaults, and a description written for an agent: what it does, when to use it, one example.
- Errors are returned as tool results with `isError: true` and `{ code, message, path, hint }`, naming the exact asset, node or field involved.
- Keep the tool count small. Prefer a patch-style `update_*` tool over many single-field setters.

## Commands

- `pnpm install`
- `pnpm build`
- `pnpm typecheck`
- `pnpm test`
- `pnpm test:golden` (golden render tests, from Phase 2)
