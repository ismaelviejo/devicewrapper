# Tool-description eval

The MCP tools are only as good as their descriptions: an agent sees nothing else. This eval checks that an agent that has read **only** [tools.md](tools.md) and [resources.md](resources.md) (exactly what an MCP client shows it) can turn realistic briefs into correct renders.

## How to run it

1. `pnpm build && pnpm docs` (so the docs match the code).
2. Make a scratch workspace with a few screenshots (phone, tablet and laptop sizes).
3. Give an agent (Claude Code works well) the briefs below, the two docs, and this way to call tools:
   ```sh
   node scripts/mcp-call.mjs <workspace> <tool> '<json args>'
   ```
   Tell it not to read the source. It should look at its renders and fix what it sees.
4. Score from `<workspace>/.calls.jsonl` (calls and errors per brief) and the agent's report (what it had to guess, what looked wrong).

`mcp-call.mjs` starts a fresh server per call, so video jobs longer than one `wait` (50 s) get interrupted. Keep videos short and small for the eval, or drive it from a real MCP client.

## Briefs

1. Hero image for a fitness app "Pulse": one phone with the workout screen, dark premium look, headline "Train smarter". PNG.
2. 6-second square MP4 for social: three phones in a fan, light background, gentle motion.
3. Portrait App Store screenshot, headline in English and Spanish; render both.
4. Laptop whose lid opens, then the camera pushes in; 4-second MP4 on a glossy reflective floor.
5. Laptop + tablet + phone showcase, clean white commercial look, transparent PNG.
6. Watch + phone, sunset mood, caption at the bottom.
7. Without compose_scene or templates: one phone doing a 360° turntable over 5 s on a dark neon background, with bloom and subtle depth of field.
8. Revise scene 6: another device color, caption on top, different screenshot.

## First run (Phase 7): findings and fixes

Two agents did all eight briefs. Every brief ended in a usable result, but the agents hit these problems, and all of them are now fixed:

| Finding | Fix |
|---|---|
| Depth of field blurred the in-focus subject (background bled over sharp edges); the suggested aperture range destroyed the image | Gather shader no longer lets farther samples spread onto nearer pixels; ±3% focus band; aperture rescaled so 0.2–0.4 is subtle (default 0.3) |
| Black display glass and the camera island reflected the studio as a white sweep on light styles | Glare layer limited to the display; island drawn above it; glass/island use a weak per-material environment map (Three ignores `envMapIntensity` with `scene.environment`) |
| Showcase: the tablet hid half the laptop screen; framing was lopsided | Large side devices go beside the main one; auto-framing re-centers on the projected extents (perspective makes near objects look bigger) |
| Bottom caption too small, overlapping devices; phone cut off at the top | Room for text computed from the actual laid-out text blocks (with wrapping); lone bottom text is subtitle-sized and opaque |
| Reflective floor: reflection cut off by framing | Auto-framing includes the visible part of the reflection |
| `padding` "barely did anything", `shift` undocumented on set_camera | Padding documented precisely; `shift` added to set_camera |
| slow-turn/turntable on a fan spun each phone separately | `target: 'all'` groups the devices and moves them as one |
| "blue" phone looked black | Lighter blue |
| `list_nodes` referenced but doesn't exist; `end` exclusivity, device colors, frame fields, locales shape, text size units undocumented; speed figures inconsistent; jobs dying with the server not mentioned | All documented in the tool descriptions; generated tables now show tuple and object shapes |
| `render` with several locales and `wait` could report a finished job as running | Jobs re-read after waiting |
| A watch composed without a screenshot showed a black screen with no hint | compose_scene notes devices without screen content |
