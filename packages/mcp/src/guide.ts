/** Served as devicewrapper://guide and (shortened) as the server's instructions. */

export const INSTRUCTIONS = `devicewrapper renders 3D device mockups (phones, tablets) for app marketing: stills and videos, headless, deterministic.
Typical workflow: create_scene → add_device (screen: 'path/to/screenshot.png') → set_camera { frame: { shot: 'hero' } } → set_background / set_lights { preset } → render_preview (look at the image, adjust) → set_track for motion → render.
Units are meters and degrees; +Y up; devices face +Z. Mutating tools return 'issues' when something needs attention. Read devicewrapper://guide for tips and devicewrapper://devices for models and colors.`;

export const GUIDE = `# devicewrapper guide

devicewrapper builds and renders 3D device mockups. Everything is a **scene**: JSON you modify with tools, saved in the workspace, rendered on demand. The same scene always renders the same pixels.

## Workflow

1. \`create_scene\` with a canvas preset ('1080p', '4k', 'square', 'portrait', 'app-store-6.9') and a lighting preset.
2. \`add_device\` with \`screen\` set to a screenshot path (imported automatically). Devices are real size: a phone is ~7 x 15 cm.
3. \`set_camera { frame: { shot: 'hero' } }\` to frame all devices. Try shots: front, hero, three-quarter, low-angle, closeup, wide.
4. \`set_background\` (solid, gradient, image, transparent) and \`set_lights { preset }\`.
5. \`render_preview\` and **look at the result**. Adjust rotation, camera, light, colors. Repeat.
6. Optional motion: \`set_track\` on devices or the camera, extend \`canvas.duration\` with \`update_scene\`, preview a few times (\`time\`).
7. \`render\` the final still or video (\`wait\` for short jobs, or poll \`get_render_job\`).

## Coordinates and scale

- Meters and degrees. +X right, +Y up, +Z toward the default camera.
- A device at [0,0,0] is centered on the origin with its screen facing +Z.
- rotation [0, -20, 0] turns the screen to face left (you see its right edge); [0, 20, 0] faces right; [-10, 0, 0] tilts the top away from the camera.
- Place a floor just under a standing phone: phone height is ~0.15 m, so a plane at y = -0.075 touches its bottom edge.
- For a device floating over a flat background with a soft shadow: add a plane with material { type: 'shadowCatcher', opacity: 0.25 } a few cm below it.

## Composition tips

- Hero shot: one phone, rotation around [0, -15..-25, 0], shot 'hero', focalLength 50–85 for a flattering, low-distortion look.
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
- Floating phone: position y oscillating ±0.004 m with easeInOutSine keyframes.
- Preview motion by rendering previews at several \`time\` values before a full video render.

## Localization

- Put {{variables}} in text2d content, set base values with \`set_variables\`, then per-locale values with \`set_variables { locale }\`.
- \`render { locales: ['en', 'es', 'ja'] }\` produces one file per language.

## Errors

Errors come back as { error: { code, message, path, hint } }. The message names the exact node, asset or field; the hint says what to do next.
`;
