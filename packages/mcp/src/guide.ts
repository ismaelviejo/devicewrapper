/** Served as devicewrapper://guide and (shortened) as the server's instructions. */

export const INSTRUCTIONS = `devicewrapper renders 3D device mockups (phones, tablets, laptops, monitors, watches) for app marketing: stills and videos, headless, deterministic.
Fastest path: compose_scene (a brief, or a template from list_templates + your screenshot paths) → render_preview (look at the image) → refine with apply_layout / apply_style / apply_motion / set_camera / update_node → render.
Low-level path: create_scene → add_device (screen: 'path/to/screenshot.png') → set_camera { frame: { shot } } → set_lights / set_background → set_track.
Units are meters and degrees; +Y up; devices face +Z. Mutating tools return 'issues' when something needs attention. Read devicewrapper://guide for tips.`;

export const GUIDE = `# devicewrapper guide

devicewrapper builds and renders 3D device mockups. Everything is a **scene**: JSON you modify with tools, saved in the workspace, rendered on demand. The same scene always renders the same pixels.

## Workflow

Start high-level, then refine:

1. \`list_templates\` and pick one, or write a brief. \`compose_scene { template: 'phone-trio', screens: ['a.png', 'b.png', 'c.png'] }\`
   or \`compose_scene { devices: [{ model: 'laptop-14', screen: 'web.png' }, { screen: 'app.png' }], style: 'dark-studio', text: [{ content: 'Ship faster' }], motion: 'push-in', duration: 5 }\`.
2. \`render_preview\` and **look at the result**.
3. Refine: \`apply_layout\` (row, arc, fan, stack, grid, circle, showcase), \`apply_style\` (light-studio, dark-studio, soft-gradient, midnight-neon, sunset, mint, product-white, transparent),
   \`apply_motion\` (float, slow-turn, turntable, rise, enter-left, orbit, push-in, lid-open, …), \`set_camera { frame: { shot } }\`, \`update_node\`, \`set_lights\`. Preview again.
4. \`render\` the final still or video (\`wait\` for stills, poll \`get_render_job\` for videos).

Low-level building blocks are always available: create_scene, add_device, add_node, set_track, set_background, set_effects.

## Coordinates and scale

- Meters and degrees. +X right, +Y up, +Z toward the default camera.
- A device at [0,0,0] is centered on the origin with its screen facing +Z.
- rotation [0, -20, 0] turns the screen to face left (you see its right edge); [0, 20, 0] faces right; [-10, 0, 0] tilts the top away from the camera.
- Place a floor just under a standing phone: phone height is ~0.15 m, so a plane at y = -0.075 touches its bottom edge.
- For a device floating over a flat background with a soft shadow: add a plane with material { type: 'shadowCatcher', opacity: 0.25 } a few cm below it.

## Composition tips

- Devices: phone-modern, phone-classic, tablet, laptop-14 (lidAngle), monitor-27, watch-45. See devicewrapper://devices for sizes and colors.
- Hero shot: one phone, rotation around [0, -15..-25, 0], shot 'hero', focalLength 50–85 for a flattering, low-distortion look.
- Mixed devices (laptop + phone, tablet + phone): layout 'showcase' puts the big one center and small ones in front.
- Pairs/trios: space phones ~0.085 m apart (x), rotate outer ones toward the center (±12–20° on Y), push the center one forward (z +0.02).
- Dark studio: background gradient #1b1d24 → #07080b, lighting 'dark' or 'dramatic', vignette 0.35.
- Light studio: background #f4f5f7 or a soft radial gradient, lighting 'soft-studio' or 'bright'.
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

## Video

- Formats: mp4 (H.264, most compatible), webm (VP9; supports transparency), mov (ProRes 4444; transparency, for editing).
- Rendering is CPU-based and deterministic: roughly 1–2 s per 1080p frame, so a 5 s clip at 30 fps takes a few minutes.
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
