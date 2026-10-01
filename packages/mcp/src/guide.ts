import { STYLE_NAMES } from "@devicewrapper/core";

/** Served as devicewrapper://guide and (shortened) as the server's instructions. */

export const INSTRUCTIONS = `devicewrapper renders 3D device mockups (phones, tablets, laptops, monitors, watches) for app marketing: stills and videos, headless, deterministic.
Fastest path: compose_scene (a brief, or a template from list_templates + your screenshot paths) → render_preview (look at the image) → refine with apply_layout / apply_style / apply_motion / set_camera / update_node → render.
Low-level path: create_scene → add_device (screen: 'path/to/screenshot.png') → set_camera { frame: { shot } } → set_lights / set_background → set_track.
Units are meters and degrees; +Y up; devices face +Z. Mutating tools return 'issues' when something needs attention. Read devicewrapper://guide for tips.
Reuse: list_templates also holds compositions and single movements saved with save_template (global = every project, project = this workspace); screenshots are slots, motion/camera/look are kept. Play a movement with apply_motion { clip }.
Save review: after presenting a finished composition (a final render), ask the user whether to save any of its movements as templates. If yes, list every candidate — each whole scene and each movement inside it (split at the camera's holds: spin reveal, punch-in, pull-out, …) with its time range, a one-line description and preview frames (render_preview at a few times) — flag near-duplicates, let the user pick, confirm name and scope per pick, and only then call save_template. Never save without that confirmation.`;

export const GUIDE = `# devicewrapper guide

devicewrapper builds and renders 3D device mockups. Everything is a **scene**: JSON you modify with tools, saved in the workspace, rendered on demand. The same scene always renders the same pixels.

## Workflow

Start high-level, then refine:

1. \`list_templates\` and pick one, or write a brief. \`compose_scene { template: 'phone-trio', screens: ['a.png', 'b.png', 'c.png'] }\`
   or \`compose_scene { devices: [{ model: 'laptop-14', screen: 'web.png' }, { screen: 'app.png' }], style: 'dark-studio', text: [{ content: 'Ship faster' }], motion: 'push-in', duration: 5 }\`.
2. \`render_preview\` and **look at the result**.
3. Refine: \`apply_layout\` (row, arc, fan, stack, grid, circle, showcase), \`apply_style\` (${STYLE_NAMES.join(", ")}),
   \`apply_motion\` (float, slow-turn, turntable, rise, enter-left, orbit, push-in, lid-open, …), \`set_camera { frame: { shot } }\`, \`update_node\`, \`set_lights\`. Preview again.
4. \`render\` the final still or video (\`wait\` for stills, poll \`get_render_job\` for videos).

Low-level building blocks are always available: create_scene, add_device, add_node, set_track, set_background, set_effects.

## Coordinates and scale

- Meters and degrees. +X right, +Y up, +Z toward the default camera.
- A device at [0,0,0] is centered on the origin with its screen facing +Z.
- rotation [0, -20, 0] turns the screen to face left (you see its right edge); [0, 20, 0] faces right; [-10, 0, 0] tilts the top away from the camera.
- Place a floor just under a standing phone: phone height is ~0.15 m, so a plane at y = -0.075 touches its bottom edge.
- For a device floating over a flat background with a soft shadow: add a plane with material { type: 'shadowCatcher', opacity: 0.25 } a few cm below it.
- For a glossy tabletop: a plane with material { type: 'reflective', strength: 0.3, blur: 0.25, fade: 0.5 } right under the devices (or apply_style { floor: { type: 'reflective' } }). Auto-framing includes the visible reflection.

## Composition tips

- Devices: phone-modern, phone-classic, tablet, laptop-14 (lidAngle), monitor-27, watch-45. See devicewrapper://devices for sizes and colors.
- Hero shot: one phone, rotation around [0, -15..-25, 0], shot 'hero', focalLength 50–85 for a flattering, low-distortion look.
- Mixed devices (laptop + phone, tablet + phone): layout 'showcase' puts the big one center and small ones in front.
- Pairs/trios: space phones ~0.085 m apart (x), rotate outer ones toward the center (±12–20° on Y), push the center one forward (z +0.02).
- Dark studio: background gradient #1b1d24 → #07080b, lighting 'dark' or 'dramatic', vignette 0.35.
- Light studio: background #f4f5f7 or a soft radial gradient, lighting 'soft-studio' or 'bright'.
- Premium hardware look: style 'glossy-dark' (reflective floor, softbox environment). Environments (update_scene environment.preset): studio, soft, softbox (crisp strip highlights on glass/metal), sunset (warm), none.
- Depth of field: set_camera { dof: { enabled: true, aperture: 0.3 } } focuses on the camera target; use it with 2+ devices at different depths. Bloom (set_effects) makes bright screens glow on dark backgrounds.
- Screens: default fit 'cover' keeps the top of the screenshot. Use fit 'contain' with a matching screen.background to show the whole image.
- Lower screen.glare (0–0.1) for flat, legible screens; raise it (0.3–0.5) for glossy product shots.

## Animation

- \`set_track { target, property, keyframes: [{ t, value, easing }] }\`. The easing on a keyframe shapes the motion toward the next one.
- Natural motion: 'easeInOut' / 'easeInOutCubic' / 'easeInOutSine'. Arrivals: 'easeOutCubic' / 'easeOutBack'.
- Turntable: rotation [0,0,0] → [0,360,0] (linear) over the whole duration.
- Camera orbit: 3+ camera position keyframes follow a smooth spline; keep the target fixed on the subject.
- Floating phone: apply_motion 'float' (or position y oscillating ±0.004 m with easeInOutSine keyframes).
- Motions layer: apply_motion 'float' then 'rise' wraps the device in a group so both play.
- Preview motion by rendering previews at several \`time\` values before a full video render.

## Rhythm reels: fast spins, punch-ins, pull-outs

Punchy app reels alternate a close-up on one spot of the screen with a pull-out to the full device, on the beat.
- \`apply_motion { preset: 'spin-reveal', duration: 0.8, amount: 380, easing: 'easeOutExpo' }\` for a fast reveal.
- \`apply_motion { preset: 'focus', target: 'phone', point: [0.5, 0.3], amount: 0.4, start: 0.75, hold: 0.4 }\` rushes the camera in to that spot of the display (point is 0..1 from the top-left of the screen, amount is the fraction of the screen height in view). It fits any screenshot: look at the screenshot and pick the spot worth showing.
- \`apply_motion { preset: 'reframe', start: 1.5, hold: 1.2 }\` pulls back out to the base camera (or \`shot\` / \`padding\` / \`shift\` for a new framing). Show headlines only on these wide beats (text opacity tracks), never over a close-up.
- Moves default to easeInOutExpo; each one only changes its own time window, so they chain. At 120 BPM a beat is 0.5 s: start moves on beats.

## Saving and reusing compositions

- \`save_template { sceneId, name, scope }\` saves a whole scene (kind 'scene'): every device screen becomes a \`{{screenN}}\` slot and every text a \`{{variable}}\`. \`compose_scene { template, screens, variables }\` replays it on any screenshots.
- \`save_template { sceneId, name, kind: 'motion', range: [t0, t1] }\` saves one movement: the camera, the device and the text tracks in that window, relative to the device and its screen size. \`apply_motion { sceneId, clip: name, start }\` plays it on any scene and device.
- scope 'global' (every workspace, default ~/.devicewrapper/templates) or 'project' (this workspace's .devicewrapper/templates). A project template overrides a global one of the same name. Keep brand colors in project templates and neutral looks in global ones.
- Save only what the user picked: after a finished composition, offer a review of every candidate movement (see the instructions) before calling save_template.

## Video

- Formats: mp4 (H.264, most compatible), webm (VP9; supports transparency), mov (ProRes 4444; transparency, for editing).
- Rendering is CPU-based and deterministic: roughly 0.5–2 s per frame (more with 4K, supersample, depth of field or bloom), so a 5 s clip at 30 fps takes a few minutes. Jobs live in the server process: keep it running until they complete.
  Draft first: \`render { format: 'mp4', width: 640, supersample: 1 }\`, check it, then render the final size.
- Poll long renders: \`get_render_job { jobId, wait: 45 }\` until status is completed (tool calls time out after ~60 s).
- Screen recordings on devices play in sync with the timeline; \`offset\` skips into the clip, \`loop\` repeats it.
- Transparent video: background { type: 'transparent' } and format webm or mov. mp4 renders a transparent background as black.

## Localization

- Put {{variables}} in text2d content, set base values with \`set_variables\`, then per-locale values with \`set_variables { locale }\`.
- \`render { locales: ['en', 'es', 'ja'] }\` produces one file per language.

## Errors

Errors come back as { error: { code, message, path, hint } }. The message names the exact node, asset or field; the hint says what to do next.
`;
