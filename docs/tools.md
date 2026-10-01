# MCP tools

_Generated from the live server by `pnpm run docs:gen` — do not edit by hand._

33 tools. Every tool returns JSON text; errors come back with `isError: true` and `{ error: { code, message, path?, hint? } }`.

- **Compose (start here):** [`compose_scene`](#compose_scene), [`list_templates`](#list_templates), [`apply_layout`](#apply_layout), [`apply_style`](#apply_style), [`apply_motion`](#apply_motion)
- **Scenes:** [`create_scene`](#create_scene), [`get_scene`](#get_scene), [`list_scenes`](#list_scenes), [`update_scene`](#update_scene), [`duplicate_scene`](#duplicate_scene), [`delete_scene`](#delete_scene), [`validate_scene`](#validate_scene), [`import_scene`](#import_scene), [`export_scene`](#export_scene)
- **Nodes and assets:** [`add_device`](#add_device), [`add_node`](#add_node), [`update_node`](#update_node), [`remove_node`](#remove_node), [`import_asset`](#import_asset)
- **Look:** [`set_camera`](#set_camera), [`set_lights`](#set_lights), [`set_background`](#set_background), [`set_effects`](#set_effects), [`set_variables`](#set_variables)
- **Animation:** [`set_track`](#set_track), [`remove_track`](#remove_track)
- **Rendering:** [`render_preview`](#render_preview), [`render`](#render), [`get_render_job`](#get_render_job), [`list_render_jobs`](#list_render_jobs), [`cancel_render_job`](#cancel_render_job)
- **Other:** [`save_template`](#save_template), [`set_audio`](#set_audio)

## Compose (start here)

### compose_scene

Build a complete scene in one call from a declarative brief (or a template), then refine it with the other tools.
Deterministic: the same brief always builds the same scene. Saved as a new scene; returns a summary.
Brief fields: devices (required, 1–12: { model, color?, screen?: path or asset ID, lidAngle? }), layout, layoutOptions, style, camera { shot, focalLength, padding, shift },
text [{ content, position: top|bottom|center|top-left|…, size?, weight?, color? }], variables, locales, motion (preset name, object, or list), duration, preset (canvas size), render.
Text: size is in canvas pixels (scaled with the output size; default ~7% of the short side for a top headline, ~4% for a bottom line); weight 100–900. The camera leaves room for text automatically.
Localization: text content may use {{variables}}; variables: { headline: 'Train smarter' }, locales: { es: { headline: 'Entrena mejor' } }; then render { locales: ['en', 'es'] }.
motion: preset names as in apply_motion (e.g. 'float', 'slow-turn', 'push-in'), or objects { preset, target?, start?, duration?, amount? }; target 'all' moves the whole arrangement as one unit.
sound: motions add matching sound effects to videos by default (Minimal pack); pass a pack name like 'cinematic' for a bigger sound, or false for silence.
duration sets the timeline length; whole-timeline motions stretch to it, entrances (rise, lid-open, …) keep their natural length.
Styles: light-studio, dark-studio, soft-gradient, midnight-neon, sunset, mint, product-white, transparent, glossy-dark, glossy-light. Layouts: hero, row, arc, fan, stack, grid, circle, showcase (default picked from the devices).
Templates (see list_templates): pass template + screens (filled into the {{screenN}} slots in order) + variables. Brief templates also take any brief field as an override;
scene templates (saved with save_template) replay a whole composition — keyframes, camera, look — and take only name, preset, canvas, duration, render, style, variables, locales.
Motion templates are single movements: play them with apply_motion { clip }.
Example: { name: 'Fitness launch', preset: '1080p', style: 'dark-studio', devices: [{ model: 'phone-modern', screen: 'screens/workout.png' }], motion: ['slow-turn', 'push-in'], duration: 5 }
Example: { template: 'phone-trio', screens: ['a.png', 'b.png', 'c.png'], style: 'mint' }
Next: render_preview to look at it, then adjust (update_node, set_camera, set_lights, apply_motion …) and render.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `template` | string |  |  | Template name from list_templates. |
| `screens` | string[] |  |  | Screenshots/recordings for the template's slots, in order (paths or asset IDs). |
| `id` | string |  |  | Scene ID. Default: from name/template, made unique. |
| `overwrite` | boolean |  | `false` |  |
| `name` | string |  |  |  |
| `concept` | string |  |  |  |
| `preset` | "720p" \| "1080p" \| "1440p" \| "4k" \| "square" \| "square-2k" \| "portrait" \| "portrait-4k" \| "app-store-6.9" \| "app-store-ipad" \| "instagram-portrait" \| "og-image" |  |  | Canvas size preset. |
| `canvas` | { width?, height?, fps?, duration? } |  |  |  |
| `duration` | number |  |  | Timeline length in seconds (shortcut for canvas.duration). |
| `devices` | { model?, id?, color?, screen?, lidAngle? }[] |  |  | Required unless a template is used. |
| `layout` | "hero" \| "row" \| "arc" \| "fan" \| "stack" \| "grid" \| "circle" \| "showcase" |  |  | Default: hero (1 device), arc (2–3 of the same kind), showcase (mixed sizes), row (4–5), grid (6+). |
| `layoutOptions` | { spacing?, angle?, depth?, columns?, tilt? } |  |  |  |
| `style` | "light-studio" \| "dark-studio" \| "soft-gradient" \| "midnight-neon" \| "sunset" \| "mint" \| "product-white" \| "transparent" \| "glossy-dark" \| "glossy-light" |  |  | Default: light-studio (or the template's). |
| `camera` | { shot?, focalLength?, padding?, shift?, dof? } |  |  |  |
| `text` | { content, position?, role?, size?, weight?, color?, font? }[] |  |  |  |
| `variables` | object |  |  |  |
| `locales` | object |  |  |  |
| `motion` | "turntable" \| "slow-turn" \| "float" \| "rise" \| … (25 values) \| { preset, target?, start?, duration?, amount?, easing?, stagger? } \| ("turntable" \| "slow-turn" \| "float" \| "rise" \| … (25 values) \| { preset, target?, start?, duration?, amount?, easing?, stagger? })[] |  |  |  |
| `render` | object |  |  | Default render settings (format, quality, supersample, transparent, time). |
| `sound` | boolean \| string |  |  | Sound effects for motions in videos: true (default, 'minimal' pack), false for silent, or a pack name like 'cinematic'. |

### list_templates

_readOnly_

Every reusable composition: built-in briefs, global templates (shared by all projects) and project templates (.devicewrapper/templates/); a project template overrides a global one of the same name.
kind 'brief' / 'scene': compose_scene { template, screens, variables }. kind 'motion': a single movement, played with apply_motion { clip, start }.
Save new ones from a scene you like with save_template.

No parameters.

### apply_layout

_idempotent_

Arrange devices (all devices by default, or `targets`) using their real sizes; they stand on a common floor line.
Layouts: hero (One device centered and turned slightly (angle, default 18°). With several devices, falls back to 'arc'.); row (Side by side, facing forward, evenly spaced (spacing = gap as a fraction of device width, default 0.25).); arc (Side by side on a gentle curve: outer devices pushed back and turned toward the center (angle default 16°).); fan (Overlapping like a hand of cards, tilted around a pivot below them (angle default 12°).); stack (Staggered diagonally in depth, all turned the same way (angle default 25°); the last device is in front.); grid (Flat grid facing the camera (columns default √n).); circle (On a ring facing outward, for turntable/carousel motion (rotate the ring with apply_motion on the group).); showcase (Largest device in the center, smaller ones in front at its sides (e.g. laptop + phone, tablet + phones).).
Options: spacing (gap as a fraction of device width), angle (degrees), depth (meters), columns (grid), tilt (X tilt in degrees for all).
Re-frame afterwards with set_camera { frame: { shot } }. Example: { sceneId: 'launch', layout: 'arc', angle: 18 }

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `sceneId` | string | yes |  | Scene ID (see list_scenes). |
| `layout` | "hero" \| "row" \| "arc" \| "fan" \| "stack" \| "grid" \| "circle" \| "showcase" | yes |  |  |
| `targets` | string[] |  |  |  |
| `spacing` | number |  |  |  |
| `angle` | number |  |  |  |
| `depth` | number |  |  |  |
| `columns` | integer |  |  |  |
| `tilt` | number |  |  |  |

### apply_style

_idempotent_

Apply a complete look in one call: background, lighting preset, environment reflections, effects and a floor (soft shadow or glossy reflection), and recolor text to match.
Styles: light-studio (Clean light-gray studio with soft light and a gentle contact shadow. The safe default.); dark-studio (Near-black studio with a soft top light, cool rim and vignette. Premium, dramatic.); soft-gradient (Airy lavender-to-blue gradient with bright, soft light. Friendly consumer-app look.); midnight-neon (Deep indigo with a hot-pink rim light and strong vignette. Bold, nightlife/fintech energy.); sunset (Warm peach-to-coral gradient with low golden light.); mint (Fresh mint gradient with bright light. Health, finance, productivity apps.); product-white (Pure white seamless background with crisp commercial lighting. Store listings, press kits.); transparent (No background (transparent PNG/WebP/WebM/MOV) with a soft shadow, for placing on your own designs.); glossy-dark (Black glossy tabletop with a soft mirror reflection and strip-softbox highlights. Premium hardware-launch look.); glossy-light (White glossy tabletop with a faint reflection and bright, even light. Clean store-listing look with extra depth.).
recolorDevices: true also switches devices to the style's suggested colors. Fine-tune afterwards with set_background / set_lights / set_effects.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `sceneId` | string | yes |  | Scene ID (see list_scenes). |
| `style` | "light-studio" \| "dark-studio" \| "soft-gradient" \| "midnight-neon" \| "sunset" \| "mint" \| "product-white" \| "transparent" \| "glossy-dark" \| "glossy-light" | yes |  |  |
| `recolorDevices` | boolean |  | `false` |  |
| `floor` | { type } \| { type, opacity? } \| { type, color, roughness?, metalness? } \| { type, strength?, blur?, fade?, shadowOpacity? } |  |  | Override the style's floor: none, shadow, solid { color }, or reflective { strength, blur }. |

### apply_motion

Add a named animation relative to the current pose. Device motions target all top-level devices by default (entrances are staggered), or `target`.
Or play a saved movement: { clip: '<motion template>', start, target? } (see list_templates, kind 'motion'); it replaces only its own time window, so clips chain on one timeline.
focus / reframe make punchy camera moves that fit any screenshot: focus { target: 'phone', point: [0.5, 0.3], amount: 0.4, start: 0.75, hold: 0.4 } rushes in to that spot of the display; reframe { start: 1.5, hold: 1 } pulls back out (to the base camera, or a shot).
Text: target a text node ID or 'texts' (all text) with fade-in, fade-out, rise, drop-in, enter-left/right, exit-left/right.
Presets: turntable (Full spin around the vertical axis (amount = degrees, default 360), constant speed.); slow-turn (Gentle turn from -amount to +amount degrees around Y (default 15).); float (Soft hovering up and down (amount = meters, default ~3% of device height).); rise (Rises into place from below while fading in (entrance).); drop-in (Drops into place from above with a small overshoot (entrance).); enter-left (Slides in from the left while turning to face the camera (entrance).); enter-right (Slides in from the right while turning to face the camera (entrance).); exit-left (Slides out to the left (exit, at the end of the timeline).); exit-right (Slides out to the right (exit, at the end of the timeline).); fade-in (Opacity 0 → 1.); fade-out (Opacity 1 → 0 at the end.); spin-reveal (Starts showing its back, spins to face the camera (entrance).); tilt-up (Starts lying back, tilts up to face the camera (entrance).); lid-open (Laptops: opens the lid from closed to its resting angle.); lid-close (Laptops: closes the lid (at the end).); screen-on (Screen brightness 0 → 1, like the display waking up.); push-in (Camera dollies toward its target (amount = fraction of distance, default 0.2).); pull-out (Camera dollies away from its target (amount default 0.2).); orbit (Camera arcs around its target (amount = total degrees, default 30), eased.); pan-left (Camera and target slide left (amount = fraction of distance, default 0.12).); pan-right (Camera and target slide right (amount default 0.12).); crane-up (Camera rises while keeping its target (amount = fraction of distance, default 0.25).); zoom-in (Narrows the field of view (amount = fraction, default 0.2).); focus (Camera rushes in to a point on a device's screen (target = device, default the one nearest the camera's aim; point = [x, y] on the display, 0..1 from top-left, default [0.5, 0.3]; amount = fraction of the screen height in view, default 0.4; angle = [yaw, pitch] off the screen normal, default [8, 4]), then holds `hold` seconds with a slow drift. Default 0.35 s, easeInOutExpo.); reframe (Camera pulls back out: to the scene's base camera, or to an auto-framed shot when shot / padding / shift are given (framed on the devices as they are posed at that moment), then holds `hold` seconds with a slow push. Default 0.45 s, easeInOutExpo.).
target 'all': every device moves as one unit (they are grouped under 'arrangement'); use it to turn or orbit a fan/arc/row as a whole, since without it turntable/slow-turn spin each device on its own axis.
Timing: start/duration in seconds (defaults: whole timeline; entrances ~1.2 s at the start; exits at the end). amount scales the motion.
Motions layer: if the property is already animated (e.g. float then rise), the device is wrapped in a group and the group is animated (stack: 'auto'; use 'replace' to overwrite).
Device motions add a matching sound effect for videos (sound: false to skip; change the pack or mix with set_audio).
The timeline is extended if a motion ends after it. Example: { sceneId: 'hero', preset: 'orbit', amount: 40 }

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `sceneId` | string | yes |  | Scene ID (see list_scenes). |
| `preset` | "turntable" \| "slow-turn" \| "float" \| "rise" \| … (25 values) |  |  | A motion preset, or use clip. |
| `clip` | string |  |  | A saved motion template (list_templates, kind 'motion') instead of a preset. |
| `target` | string |  |  |  |
| `start` | number |  |  |  |
| `duration` | number |  |  |  |
| `amount` | number |  |  |  |
| `easing` | string |  |  |  |
| `stagger` | number |  |  |  |
| `stack` | "auto" \| "replace" |  | `"auto"` |  |
| `point` | [number, number] |  |  | focus: [x, y] on the display, 0..1 from the top-left. |
| `angle` | [number, number] |  |  | focus: [yaw, pitch] degrees off the screen normal (default [8, 4]). |
| `hold` | number |  |  | focus / reframe: seconds to hold after arriving, with a slow drift. |
| `drift` | number |  |  | focus / reframe: how far the camera keeps moving during the hold (fraction of its distance). |
| `shot` | string |  |  | reframe: auto-frame with this shot instead of returning to the base camera. |
| `padding` | number |  |  | reframe: framing padding. |
| `shift` | [number, number] |  |  | reframe: [x, y] subject shift in the frame. |
| `sound` | boolean |  | `true` | Add the motion's sound effect for videos (e.g. swipe for spins and slides). Re-applying replaces its earlier cues. |

## Scenes

### create_scene

Create a new, empty scene and save it. This is the first call of every workflow.
The scene starts with studio lighting (change with `lighting`), a light gray background, and a camera looking at the origin.
Units are meters (a phone is ~0.07 x 0.15 m) and degrees. +Y is up; the camera looks toward -Z by default.
Next steps: add_device → import screenshots (add_device's `screen` accepts a file path) → set_camera { frame: { shot: 'hero' } } → render_preview.
Example: { name: 'Fitness hero', preset: '1080p', lighting: 'soft-studio', background: { type: 'gradient', kind: 'radial', stops: [{ color: '#ffffff', offset: 0 }, { color: '#dfe4ee', offset: 1 }] } }

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | string |  |  | Scene ID. Default: derived from name (or 'scene'), made unique. |
| `name` | string |  |  |  |
| `description` | string |  |  |  |
| `preset` | "720p" \| "1080p" \| "1440p" \| "4k" \| "square" \| "square-2k" \| "portrait" \| "portrait-4k" \| "app-store-6.9" \| "app-store-ipad" \| "instagram-portrait" \| "og-image" |  |  | Canvas size preset. Explicit canvas.width/height win. |
| `canvas` | { width?, height?, fps?, duration? } |  |  | Width, height, fps (default 30), duration seconds (default 5). |
| `background` | { type, color? } \| { type, kind?, angle?, center?, radius?, stops } \| { type, asset, fit?, color? } \| { type, asset, fit?, loop?, offset?, color? } \| { type } |  |  | Default: solid #f2f2f4. |
| `lighting` | "none" \| "studio" \| "soft-studio" \| "dramatic" \| "dark" \| "bright" \| "sunset" \| "product" |  | `"studio"` | Lighting preset: studio, soft-studio, dramatic, dark, bright, sunset, product, or 'none'. |
| `overwrite` | boolean |  | `false` | Replace an existing scene with the same ID. |

### get_scene

_readOnly_

Read a scene. detail 'summary' (default) is a compact overview: nodes with positions and screens, lights, camera, tracks, assets.
detail 'full' returns the complete canonical scene JSON (every field, including defaults).

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `sceneId` | string | yes |  | Scene ID (see list_scenes). |
| `detail` | "summary" \| "full" |  | `"summary"` |  |

### list_scenes

_readOnly_

List every scene saved in this workspace with its size, duration and node counts.

No parameters.

### update_scene

_idempotent_

Change scene-level settings. Every field is optional; objects are merged (only the fields you pass change).
canvas: width, height, fps, duration (seconds). environment: reflection/ambient preset (studio | soft | softbox | sunset | none), intensity, rotation.
render: default output settings (format, quality, transparent, supersample, time). materials: named materials nodes can reference by ID (null deletes one).
Example: { sceneId: 'hero', preset: '4k', canvas: { duration: 8, fps: 60 } }

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `sceneId` | string | yes |  | Scene ID (see list_scenes). |
| `name` | string \| null |  |  |  |
| `description` | string \| null |  |  |  |
| `seed` | integer |  |  | Seed for procedural effects such as grain. |
| `preset` | "720p" \| "1080p" \| "1440p" \| "4k" \| "square" \| "square-2k" \| "portrait" \| "portrait-4k" \| "app-store-6.9" \| "app-store-ipad" \| "instagram-portrait" \| "og-image" |  |  | Sets canvas width and height. |
| `canvas` | { width?, height?, fps?, duration? } |  |  |  |
| `environment` | { preset?, intensity?, rotation? } |  |  |  |
| `render` | { format?, quality?, transparent?, supersample?, time? } |  |  |  |
| `defaultLocale` | string |  |  |  |
| `materials` | object |  |  | Named materials to add/replace (null removes). |

### duplicate_scene

Copy a scene under a new ID, e.g. to try a variation without losing the original.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `sceneId` | string | yes |  | Scene ID (see list_scenes). |
| `newId` | string |  |  | Default: '<sceneId>-2', '-3', … |
| `name` | string |  |  |  |

### delete_scene

_destructive_

Permanently delete a scene file. Rendered outputs and imported source files are not touched.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `sceneId` | string | yes |  | Scene ID (see list_scenes). |

### validate_scene

_readOnly_

Check a saved scene (sceneId) or raw scene JSON (scene) for problems before rendering:
missing assets or files, unknown devices/colors/materials, bad parents, invalid animation targets/properties/values,
undefined text variables, unsupported formats, and features the current renderer cannot draw yet.
Returns { valid, errors[], warnings[] }; each issue has code, message, path and often a hint.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `sceneId` | string |  |  | Scene ID (see list_scenes). |
| `scene` | object |  |  | Raw scene JSON to check instead of a saved scene. |

### import_scene

Save raw scene JSON (for example from export_scene, a template, or another project) as a scene in this workspace. The JSON is validated and upgraded to the current schema version.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `scene` | object | yes |  | Scene JSON. Its 'id' is used unless you pass id. |
| `id` | string |  |  | Stable identifier. Letters, digits, '-' and '_'. |
| `overwrite` | boolean |  | `false` |  |

### export_scene

Return a scene as canonical JSON (sorted keys, all defaults filled). Optionally also write it to a workspace path. Identical scenes always export byte-identically.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `sceneId` | string | yes |  | Scene ID (see list_scenes). |
| `path` | string |  |  | Workspace-relative .json path to write. |

## Nodes and assets

### add_device

Add a device (phone, tablet, ...) to a scene. Real-world size in meters, centered at `position`, screen facing +Z (toward the default camera).
Models and colors (or pass any hex color): laptop-14 (space-black, silver, midnight); monitor-27 (silver, space-black, white); phone-classic (graphite, mint, lavender, cream); phone-modern (black, silver, natural, blue, white, midnight); tablet (space-gray, silver, blue); watch-45 (midnight, starlight, red, silver). Sizes: devicewrapper://devices.
`screen` accepts an asset ID, a workspace file path to a PNG/JPEG/WebP/SVG screenshot or an MP4/MOV/WebM screen recording (imported automatically), or a full screen object.
Screen recordings play in sync with the timeline (loop and offset are set on screen.source: { type: 'video', asset, loop, offset }).
Screenshots are fit with 'cover' anchored to the top by default, which suits app screens.
Example: { sceneId: 'hero', model: 'phone-modern', color: 'black', screen: 'screens/home.png', rotation: [0, -18, 0] }
Then frame it: set_camera { sceneId, frame: { shot: 'hero' } }.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `sceneId` | string | yes |  | Scene ID (see list_scenes). |
| `model` | string |  | `"phone-modern"` | Device model ID. |
| `id` | string |  |  | Default: 'phone', 'phone-2', 'tablet', … by category. |
| `name` | string |  |  |  |
| `color` | string |  |  | Color variant name (e.g. 'black', 'silver') or hex. Default: the model's first color. |
| `screen` | string \| { source?, fit?, focus?, crop?, rotation?, brightness?, glare?, background? } |  |  | Screen content. A string is an asset ID or a file path; or a full screen object. |
| `position` | [number, number, number] |  |  | Meters. Default [0,0,0]. |
| `rotation` | [number, number, number] |  |  | Degrees [x,y,z]. [0,-20,0] turns the screen to face left (showing the right edge); [0,20,0] faces right. |
| `scale` | number |  |  |  |
| `parent` | string |  |  | Group node to attach to. |
| `castShadow` | boolean |  |  |  |
| `lidAngle` | number |  |  | Laptops: lid opening in degrees (0 closed, 90 upright, default ≈110). |

### add_node

Add a non-device node:
- plane: floor or wall. Faces +Y (a floor) by default; rotation [90,0,0] makes a wall facing the camera. For a floating device over a flat background, use material { type: 'shadowCatcher' } so only the shadow shows; material { type: 'reflective' } adds a glossy mirror image as well.
- primitive: box | sphere | cylinder | cone | torus | capsule, sized in meters, for props and pedestals.
- group: an empty transform; set other nodes' `parent` to it to move/rotate them together.
- text2d: text drawn over the frame at a normalized `anchor` [x, y] (0..1, origin top-left); supports {{variables}} for localization.
Example floor: { sceneId: 'hero', node: { kind: 'plane', transform: { position: [0, -0.08, 0] }, material: { type: 'shadowCatcher', opacity: 0.3 } } }
Example headline: { sceneId: 'hero', node: { kind: 'text2d', content: '{{headline}}', anchor: [0.5, 0.1], size: 72, color: '#111111' } }

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `sceneId` | string | yes |  | Scene ID (see list_scenes). |
| `node` | { id?, name?, parent?, transform?, visible?, opacity?, castShadow?, receiveShadow?, kind, size?, material? } \| { id?, name?, parent?, transform?, visible?, opacity?, castShadow?, receiveShadow?, kind, shape, size?, cornerRadius?, material? } \| { id?, name?, parent?, transform?, visible?, opacity?, castShadow?, receiveShadow?, kind } \| { id?, name?, kind, content, font?, size?, weight?, color?, align?, anchor?, rotation?, letterSpacing?, lineHeight?, maxWidth?, visible?, opacity? } | yes |  |  |

### update_node

_idempotent_

Change any node (device, plane, primitive, group, text2d). `patch` is a JSON Merge Patch over the node:
objects merge, arrays and values replace, null deletes an optional field. id and kind cannot change.
Common patches:
- move/rotate: { transform: { position: [0, 0.02, 0], rotation: [0, -25, 0] } }
- device color: { color: 'silver' }
- screen fit/look: { screen: { fit: 'contain', background: '#ffffff', glare: 0.1 } }
- hide: { visible: false }   - re-parent: { parent: 'group-1' }   - detach: { parent: null }
- text: { content: 'New title', size: 80 }
`screen` (optional) is the same shortcut as in add_device: an asset ID or a file path sets the screen content.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `sceneId` | string | yes |  | Scene ID (see list_scenes). |
| `id` | string | yes |  | Node ID (get_scene lists them). |
| `patch` | object |  | `{}` | JSON Merge Patch applied to the node. |
| `screen` | string \| { source?, fit?, focus?, crop?, rotation?, brightness?, glare?, background? } |  |  | Screen content. A string is an asset ID or a file path; or a full screen object. |

### remove_node

_destructive_

Remove a node and any animation tracks targeting it. Children are re-attached to the removed node's parent, or removed too with recursive: true.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `sceneId` | string | yes |  | Scene ID (see list_scenes). |
| `id` | string | yes |  | Node ID (get_scene lists them). |
| `recursive` | boolean |  | `false` |  |

### import_asset

Register a file from the workspace as a scene asset: images (PNG, JPEG, WebP, SVG), videos (MP4, MOV, WebM), fonts (TTF, OTF, WOFF, WOFF2).
The file is referenced in place (not copied), identified by its content, and probed for size/duration. Paths are relative to the workspace root.
Optionally apply it right away: screenOf sets it as a device's screen, asBackground makes it the background.
(add_device, update_node and set_background also accept file paths directly, so this tool is mainly for naming assets or reusing one file in several places.)
Example: { sceneId: 'hero', path: 'marketing/screens/home.png', id: 'home', screenOf: 'phone' }

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `sceneId` | string | yes |  | Scene ID (see list_scenes). |
| `path` | string | yes |  | Workspace-relative path (or absolute path inside an allowed root). |
| `id` | string |  |  | Asset ID. Default: the file name without extension. |
| `type` | "image" \| "video" \| "font" |  |  | Expected type; import fails if the file is something else. |
| `screenOf` | string |  |  | Device node whose screen should show this asset. |
| `asBackground` | boolean |  | `false` |  |

## Look

### set_camera

_idempotent_

Position and aim the scene camera. Two ways, combinable:
1) Auto-frame (recommended): frame: { shot, targets?, padding?, shift? } computes position/target so the targets fill the frame.
   Shots: front (Straight on.); hero (Slightly right and above: the default product shot.); closeup (Tight crop; the subject overflows the frame edges.); wide (Lots of breathing room.); three-quarter (Strong 45 degree angle showing depth.); low-angle (From below, heroic.); high-angle (From above.); top-down (Flat lay from directly above (lay devices on their back).); side (Profile view.).
   targets defaults to every device (plus the visible part of their reflection on a reflective floor).
   padding enlarges the subject's extent before fitting: 0.15 ≈ 7% margin per side (shot default), 0.5 ≈ 17%, 1 = subject fills half the frame; negative crops in.
   shift [x, y] then moves the subject within the frame by fractions of the frame: [0, 0.15] moves it down 15% (room for a headline on top), [0, -0.15] up (room for a caption).
   Framing ignores text; leave room for text with shift and padding.
2) Manual: position, target (look-at point), fov (vertical degrees) or focalLength (mm, 35mm-equivalent), roll.
Lens choice changes perspective: 50–85 mm is flattering for products; 24–35 mm is dramatic. When both are given, fov/focalLength apply first, then framing.
Example: { sceneId: 'hero', focalLength: 70, frame: { shot: 'hero', padding: 0.2 } }

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `sceneId` | string | yes |  | Scene ID (see list_scenes). |
| `type` | "perspective" \| "orthographic" |  |  |  |
| `position` | [number, number, number] |  |  |  |
| `target` | [number, number, number] |  |  |  |
| `fov` | number |  |  | Vertical field of view, degrees. |
| `focalLength` | number |  |  | 35mm-equivalent focal length in mm (overrides fov). |
| `roll` | number |  |  | Degrees. |
| `orthoHeight` | number |  |  | Orthographic visible height, meters. |
| `near` | number |  |  |  |
| `far` | number |  |  |  |
| `dof` | { enabled?, focusDistance?, aperture? } |  |  | Depth of field (rendered): blurs what is nearer or farther than the focus. focusDistance null = focus on the camera target (meters otherwise); aperture 0..1 = blur strength (0.2–0.4 subtle, 0.6–1 strong); everything within ±3% of the focus distance stays sharp. Image backgrounds blur too. |
| `frame` | { shot?, targets?, direction?, padding?, shift? } |  |  |  |

### set_lights

Apply a lighting preset and/or add, change or remove individual lights.
Presets: studio (Neutral three-point studio light. Good default for any background.); soft-studio (Very soft, low-contrast light with gentle shadows. Clean, friendly look.); dramatic (Hard side light with a cool rim and deep shadows. Use with dark backgrounds.); dark (Low-key light for dark studio shots, with a subtle blue rim.); bright (High-key, airy light for white or pastel backgrounds.); sunset (Warm low sun from the left with a purple fill.); product (Crisp commercial product light: bright key, soft fill, strong back rim for edge highlights.).
A preset replaces all lights and the environment (reflections); keepEnvironment: true keeps the current environment.
Preset light IDs are stable (key, fill, rim, ambient), so you can refine afterwards: { lights: [{ id: 'key', intensity: 3 }] }.
lights (mode 'merge', default) patches lights by ID; a new ID creates a light and needs a `type`. mode 'replace' replaces the whole list.
Types: ambient, hemisphere, directional (sun-like, casts shadows), point, spot. Positions are meters; directional/spot aim from position to target.
Example: { sceneId: 'hero', preset: 'dark', lights: [{ id: 'rim', color: '#ff7ad9', intensity: 2.5 }] }

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `sceneId` | string | yes |  | Scene ID (see list_scenes). |
| `preset` | "studio" \| "soft-studio" \| "dramatic" \| "dark" \| "bright" \| "sunset" \| "product" |  |  |  |
| `keepEnvironment` | boolean |  | `false` |  |
| `mode` | "merge" \| "replace" |  | `"merge"` |  |
| `lights` | { id, type?, color?, groundColor?, intensity?, position?, target?, castShadow?, shadow?, angle?, penumbra?, distance?, decay? }[] |  |  |  |
| `remove` | string[] |  |  | Light IDs to delete. |

### set_background

_idempotent_

Set what is drawn behind the 3D scene. One of:
- { type: 'solid', color: '#0b0b0f' }
- { type: 'gradient', kind: 'linear', angle: 180, stops: [{ color: '#1a1f3a', offset: 0 }, { color: '#05060a', offset: 1 }] }  (angle 180 = top→bottom)
- { type: 'gradient', kind: 'radial', center: [0.5, 0.45], radius: 0.8, stops: [...] }
- { type: 'image', asset: 'bg' | 'path/to/bg.jpg', fit: 'cover' }  (a file path is imported automatically)
- { type: 'video', asset: 'path/to/loop.mp4', fit: 'cover', loop: true }  (plays in sync with the timeline)
- { type: 'transparent' }  (PNG/WebP stills with alpha; pair with a shadowCatcher floor for a soft shadow)
Backgrounds are not lit and don't receive shadows. For a visible floor or wall, add a plane with add_node.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `sceneId` | string | yes |  | Scene ID (see list_scenes). |
| `background` | { type, color? } \| { type, kind?, angle?, center?, radius?, stops } \| { type, asset, fit?, color? } \| { type, asset, fit?, loop?, offset?, color? } \| { type } | yes |  | What is drawn behind the 3D scene. |

### set_effects

_idempotent_

Post-processing effects (one of each type):
- vignette { strength 0..1, color }: darkens edges, focuses attention.
- bloom { strength, threshold 0..1, radius 0..1 }: glow around bright areas (bright screens, rims).
- fog { color, near, far } (meters from camera): depth haze; match the background color.
- grain { amount 0..1 }: subtle film grain, deterministic per frame.
effects replaces the whole list; upsert adds or patches effects by type; remove deletes by type.
Example: { sceneId: 'hero', upsert: [{ type: 'vignette', strength: 0.3 }, { type: 'bloom', strength: 0.35 }] }

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `sceneId` | string | yes |  | Scene ID (see list_scenes). |
| `effects` | ({ type, strength?, color? } \| { type, strength?, threshold?, radius? } \| { type, color?, near?, far? } \| { type, amount? })[] |  |  |  |
| `upsert` | { type, strength?, color?, threshold?, radius?, near?, far?, amount? }[] |  |  |  |
| `remove` | ("vignette" \| "bloom" \| "fog" \| "grain")[] |  |  |  |

### set_variables

_idempotent_

Set values for {{placeholders}} used in text2d nodes. Without `locale` you set the base values; with `locale` you set that language's overrides.
Rendering with locales: ['en', 'es', 'ja'] (see render) produces one output per language. {{locale}} is always available.
null removes a variable. removeLocale deletes a whole language.
Example: { sceneId: 'hero', variables: { headline: 'Train smarter' } } then { sceneId: 'hero', locale: 'es', variables: { headline: 'Entrena mejor' } }

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `sceneId` | string | yes |  | Scene ID (see list_scenes). |
| `variables` | object |  |  |  |
| `locale` | string |  |  | Locale code such as es, fr, de, ja, pt-BR. |
| `defaultLocale` | string |  |  |  |
| `removeLocale` | string |  |  |  |

## Animation

### set_track

_idempotent_

Animate one property of one target with keyframes. target is a node ID, a light ID, or 'camera'.
Animatable: nodes: position, rotation, scale, opacity, visible (+ devices: screen.brightness, screen.glare; text2d: anchor, size, color, rotation, opacity);
camera: position, target, fov, roll, dof.focusDistance, dof.aperture; lights: intensity, color, position, target (+ spot: angle, penumbra). Full table: devicewrapper://animatable.
Keyframes: { t: seconds, value, easing? }. `easing` shapes the segment from that keyframe to the next.
Easings: linear, step, easeIn, easeOut, easeInOut, easeInQuad, easeOutQuad, easeInOutQuad, easeInCubic, easeOutCubic, easeInOutCubic, easeInSine, easeOutSine, easeInOutSine, easeInExpo, easeOutExpo, easeInOutExpo, easeOutBack, or { cubicBezier: [x1, y1, x2, y2] }. Default 'linear'; use 'easeInOut' or 'easeInOutCubic' for natural product motion.
Rotation lerps Euler degrees, so [0,0,0] → [0,360,0] is a full turntable spin. Camera position/target with 3+ keyframes follow a smooth spline.
mode 'replace' (default) replaces the track; 'merge' upserts keyframes by time. Keyframes after canvas.duration are never reached (extend it with update_scene).
Example (slow turn): { sceneId: 'hero', target: 'phone', property: 'rotation', keyframes: [{ t: 0, value: [0, -25, 0], easing: 'easeInOut' }, { t: 5, value: [0, 20, 0] }] }
Example (camera push-in): { sceneId: 'hero', target: 'camera', property: 'fov', keyframes: [{ t: 0, value: 32, easing: 'easeOutCubic' }, { t: 5, value: 26 }] }

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `sceneId` | string | yes |  | Scene ID (see list_scenes). |
| `target` | string | yes |  | Node ID, light ID, or 'camera'. |
| `property` | string | yes |  |  |
| `keyframes` | { t, value, easing? }[] | yes |  |  |
| `interpolation` | "auto" \| "linear" \| "spline" \| "slerp" |  |  |  |
| `mode` | "replace" \| "merge" |  | `"replace"` |  |

### remove_track

_destructive_

Delete the animation of one property of a target, or every track of that target when property is omitted.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `sceneId` | string | yes |  | Scene ID (see list_scenes). |
| `target` | string | yes |  |  |
| `property` | string |  |  |  |

## Rendering

### render_preview

_readOnly_

Render a small, fast still of the scene and return it as an image you can look at. Use it after every meaningful change to check
composition, framing, lighting and screen content, then refine. Previews skip supersampling, so edges are slightly rougher than final renders.
time picks the moment on the timeline (seconds). Also saved to <output>/<sceneId>/preview.png.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `sceneId` | string | yes |  | Scene ID (see list_scenes). |
| `time` | number |  |  | Timeline time in seconds. Default: the scene's render.time (0). |
| `locale` | string |  |  |  |
| `size` | integer |  | `640` | Longest side in pixels. |
| `transparent` | boolean |  |  |  |

### render

Render final output as a background job. Stills: png | jpeg | webp. Video: mp4 (H.264) | webm (VP9) | mov (ProRes 4444, supports alpha).
Size defaults to the scene canvas; pass preset ('1080p', '4k', …) or width/height (aspect is kept if you pass only one).
locales: ['en', 'es', 'fr'] renders one output per language (one job each).
Videos include the scene's sound (motion effects, cues, music; AAC in MP4, Opus in WebM, PCM in MOV). audio: false renders silent.
Returns job IDs immediately. `wait` (max 50 s) blocks until the jobs finish or the time runs out; stills usually finish in a few seconds.
Videos take longer: CPU rendering costs roughly 0.5–2 s per frame (more at 4K, with supersample 2+, depth of field or bloom). Poll get_render_job with wait: 45 until completed. Draft with supersample: 1 and a small width first.
Jobs run inside this server process: keep the server running until they complete (a server restart marks running jobs INTERRUPTED).
Otherwise poll get_render_job. Output paths are relative to the workspace. Default path: .devicewrapper/output/<sceneId>/<sceneId>[-<locale>].<ext>.
Example: { sceneId: 'hero', format: 'png', preset: '4k', wait: 45 }

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `sceneId` | string | yes |  | Scene ID (see list_scenes). |
| `format` | "png" \| "jpeg" \| "webp" \| "mp4" \| "webm" \| "mov" |  |  | Default: the scene's render.format (png). |
| `preset` | "720p" \| "1080p" \| "1440p" \| "4k" \| "square" \| "square-2k" \| "portrait" \| "portrait-4k" \| "app-store-6.9" \| "app-store-ipad" \| "instagram-portrait" \| "og-image" |  |  |  |
| `width` | integer |  |  |  |
| `height` | integer |  |  |  |
| `time` | number |  |  | Stills: timeline time in seconds. |
| `start` | number |  |  | Video: start time, seconds. |
| `end` | number |  |  | Video: end time in seconds, exclusive (start 0, end 1 at 30 fps = 30 frames). Default: canvas.duration. |
| `locale` | string |  |  |  |
| `locales` | string[] |  |  | Render once per locale. |
| `transparent` | boolean |  |  |  |
| `supersample` | integer |  |  | Default: scene render.supersample (2). |
| `quality` | integer |  |  |  |
| `output` | string |  |  | Output path. With locales, include {locale} in it, e.g. 'out/hero-{locale}.png'. |
| `audio` | boolean |  |  | Video: include the scene's sound (default true when it has any). false = silent. |
| `wait` | number |  | `0` | Seconds (max 50) to wait for completion before returning. MCP clients time out at ~60s, so poll get_render_job for longer renders. |

### get_render_job

_readOnly_

Status of a render job: queued | running | completed | failed | cancelled, with progress %, frames and output path. `wait` (max 50 s) blocks until it finishes or the time runs out; call again while it is still running.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `jobId` | string | yes |  |  |
| `wait` | number |  | `0` | Seconds (max 50) to block waiting for completion. |

### list_render_jobs

_readOnly_

Recent render jobs, newest first, optionally for one scene.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `sceneId` | string |  |  | Scene ID (see list_scenes). |
| `limit` | integer |  | `20` |  |

### cancel_render_job

_destructive_

Cancel a queued or running render. Finished jobs are unaffected.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `jobId` | string | yes |  |  |

## Other

### save_template

Save a composition the user liked so it can be reused, in this project or (scope 'global') in every project.
kind 'scene' (default): the whole scene — devices, look, camera, every keyframe. Each device screen becomes a {{screenN}} slot and each text a {{variable}} (named after the text node),
so compose_scene { template, screens, variables } replays the same motion on another project's screenshots.
kind 'motion': one movement — the camera, one device and the text tracks over range [start, end] — stored relative to the device and its screen size; play it with apply_motion { clip, start }.
Before saving, show the user what will be saved and get a yes: never save without being asked to.
Example: { sceneId: 'reel-home', name: 'punch-in-top', kind: 'motion', range: [0.75, 1.5], scope: 'global', description: 'Slams in to the top third of the screen' }

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `sceneId` | string | yes |  | Scene ID (see list_scenes). |
| `name` | string | yes |  | Template name (letters, digits, '-', '_'); the file is <name>.json. |
| `title` | string |  |  |  |
| `description` | string |  |  |  |
| `kind` | "scene" \| "motion" |  | `"scene"` |  |
| `scope` | "project" \| "global" |  | `"project"` | project: .devicewrapper/templates in this workspace. global: shared by every workspace. |
| `range` | [number, number] |  |  | motion: [start, end] seconds. Default: the whole timeline. |
| `target` | string |  |  | motion: the device the movement is about. Default: the scene's only device. |
| `includeCamera` | boolean |  | `true` | motion: include the camera (its framing is saved even when it doesn't move). |
| `includeText` | boolean |  | `true` | motion: include text tracks (replayed on the target scene's text nodes, in order). |
| `textVariables` | boolean |  | `true` | scene: turn each text into a {{variable}} so it can be replaced per project. |
| `overwrite` | boolean |  | `false` |  |

### set_audio

Sound for video renders (stills ignore it). Motion presets already add matching effects (swipe for spins and slides, open for rises, drop for drop-ins, wake for screen-on); use this to change the pack, add or remove cues, set volume, or add music.
pack: the sonic personality for cues given by name: minimal (Dry, precise, almost invisible); soft (Rounded felt, warm and reassuring); glass (Bright, crystalline, and premium); arcade (Chunky pixels and cheerful voltage); mechanical (Switches, relays, and firm detents); organic (Wood, water, breath, and small stones); dreamy (Airy blooms, soft light, and slow sparkle); scifi (Clean holographic pings with a restrained digital shimmer); rubber (Tactile elastic taps with a quick, friendly rebound); cinematic (Deep impacts, polished tails, and quiet scale); studio (Tactile editing precision with warm cinematic restraint); zen (Pure tones, dry wood, and brief washi detail). Default minimal (dry, subtle); cinematic or glass suit launch videos.
add: [{ t, sound, gain? }] with sound = a cue name ('swipe', 'drop', 'open', 'close', 'snap', 'wake', 'select', 'success', … see devicewrapper://sounds) or 'pack/cue'; or { t, asset: 'sfx/boom.wav' } for your own file (imported automatically).
remove: 'all' | 'motion' (cues the motion presets added) | 'manual' | [indices]. music: { asset: 'audio/track.mp3', volume?, offset?, loop?, fadeIn?, fadeOut? } or null to remove.
enabled: false makes videos silent. volume: master level (1 = as designed).
Example: { sceneId: 'launch', pack: 'cinematic', add: [{ t: 2.4, sound: 'success' }], music: { asset: 'audio/bed.mp3', volume: 0.4 } }

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `sceneId` | string | yes |  | Scene ID (see list_scenes). |
| `enabled` | boolean |  |  |  |
| `pack` | "minimal" \| "soft" \| "glass" \| "arcade" \| "mechanical" \| "organic" \| "dreamy" \| "scifi" \| "rubber" \| "cinematic" \| "studio" \| "zen" |  |  |  |
| `volume` | number |  |  |  |
| `add` | { t, sound?, asset?, gain? }[] |  |  |  |
| `remove` | "all" \| "motion" \| "manual" \| integer[] |  |  |  |
| `music` | { asset, volume?, offset?, loop?, fadeIn?, fadeOut? } \| null |  |  |  |
