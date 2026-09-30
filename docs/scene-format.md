# Scene format

A scene is one JSON document that fully describes a mockup: canvas, background, camera, lights, devices and other objects, animation, effects, text and localization. The same scene always renders the same pixels (in deterministic mode).

- The Zod schemas in `packages/schema/src` are the source of truth. The JSON Schema is served as the MCP resource `devicewrapper://schema/scene` and exported by `sceneJsonSchema()`.
- Every field has a default, so `{ "id": "hero" }` is a valid (empty) scene.
- Scenes are saved canonically: keys sorted, 2-space indent, trailing newline. Identical scenes are byte-identical, so they diff well in git.
- `schemaVersion` is `1`. Older documents are migrated on load; newer ones are refused.

## Units and axes

| | |
|---|---|
| Distances | meters (devices are real size: a phone is ~0.15 m tall) |
| Angles | degrees |
| Time | seconds; frame *n* is at `n / fps` |
| Axes | +X right, +Y up, +Z toward the default camera. A device at the origin faces +Z |
| Rotation | Euler `[x, y, z]`, applied in XYZ order. `[0, -20, 0]` turns a screen to the left |
| Colors | `#rrggbb` or `#rrggbbaa` |
| 2D positions (text, gradient centers) | normalized canvas coordinates, 0..1, origin top-left |
| IDs | letters, digits, `-` and `_` |

## A complete small scene

```json
{
  "schemaVersion": 1,
  "id": "hero",
  "canvas": { "width": 1920, "height": 1080, "fps": 30, "duration": 5 },
  "background": {
    "type": "gradient", "kind": "radial", "center": [0.5, 0.42], "radius": 0.8,
    "stops": [{ "color": "#ffffff", "offset": 0 }, { "color": "#e3e6ec", "offset": 1 }]
  },
  "environment": { "preset": "soft", "intensity": 1.2, "rotation": 0 },
  "camera": { "position": [0.1, 0.04, 0.68], "target": [0, 0.012, 0], "fov": 19.5 },
  "lights": [
    { "id": "key", "type": "directional", "position": [2, 4, 3], "intensity": 1.4, "shadow": { "softness": 8 } },
    { "id": "fill", "type": "hemisphere", "intensity": 0.6 }
  ],
  "assets": {
    "home": { "type": "image", "path": "design/home.png" }
  },
  "nodes": [
    {
      "id": "phone", "kind": "device", "model": "phone-modern", "color": "black",
      "transform": { "rotation": [0, -18, 0] },
      "screen": { "source": { "type": "image", "asset": "home" } }
    },
    {
      "id": "floor", "kind": "plane", "size": [20, 20],
      "transform": { "position": [0, -0.0742, 0] },
      "material": { "type": "shadowCatcher", "opacity": 0.28 }
    },
    { "id": "headline", "kind": "text2d", "content": "{{headline}}", "size": 72, "weight": 700, "anchor": [0.5, 0.1] }
  ],
  "animation": {
    "tracks": [
      {
        "target": "phone", "property": "rotation",
        "keyframes": [
          { "t": 0, "value": [0, -18, 0], "easing": "easeInOutSine" },
          { "t": 5, "value": [0, 18, 0] }
        ]
      }
    ]
  },
  "effects": [{ "type": "vignette", "strength": 0.2 }],
  "variables": { "headline": "Train smarter" },
  "locales": { "es": { "headline": "Entrena mejor" } },
  "render": { "format": "png", "supersample": 2 }
}
```

You rarely write this by hand: `compose_scene` builds it from a short brief, and the other tools edit it. But it's plain JSON, so you can also generate it, template it, or commit it.

## Top-level fields

| Field | Default | What it is |
|---|---|---|
| `id` | required | Scene ID (also the file name in `.devicewrapper/scenes/`) |
| `name`, `description` | – | Free text |
| `seed` | 1 | Seed for procedural randomness (film grain) |
| `canvas` | 1920×1080, 30 fps, 5 s | Output size, frame rate, timeline length |
| `background` | solid `#f2f2f4` | What's behind the 3D scene (below) |
| `environment` | `studio`, 1, 0 | Image-based lighting and reflections: `studio`, `soft`, `softbox`, `sunset`, `none`; `intensity`; `rotation` (degrees around Y) |
| `camera` | perspective at `[0,0,1.2]` | The single camera (below) |
| `lights` | `[]` | Lights (below). Lighting presets fill this in |
| `nodes` | `[]` | Devices, planes, primitives, groups, text |
| `materials` | `{}` | Named materials that nodes can reference by ID |
| `assets` | `{}` | Imported files (images, videos, fonts) by ID |
| `animation.tracks` | `[]` | Keyframe tracks |
| `effects` | `[]` | Vignette, bloom, fog, grain |
| `variables`, `locales`, `defaultLocale` | – | Text localization |
| `render` | png, quality 90, supersample 2 | Default output settings; render calls override them |

## Background

| `type` | Fields |
|---|---|
| `solid` | `color` |
| `gradient` | `kind` (`linear` / `radial`), `angle` (linear, 180 = top→bottom), `center` + `radius` (radial), `stops` [{ `color`, `offset` 0..1 }] |
| `image` | `asset`, `fit` (`cover` / `contain` / `fill`), `color` (around `contain`) |
| `video` | `asset`, `fit`, `loop`, `offset` (seconds into the clip at t = 0), `color` |
| `transparent` | Only with transparent output (PNG/WebP, WebM, MOV) |

Backgrounds are drawn in 2D behind the 3D render, so a gradient is exact and never lit or shadowed.

## Camera

| Field | Meaning |
|---|---|
| `type` | `perspective` or `orthographic` |
| `position`, `target` | Where it is and what it looks at |
| `roll` | Rotation around the view axis |
| `fov` | Vertical field of view (perspective). `set_camera { focalLength }` converts from 35 mm-equivalent millimeters |
| `orthoHeight` | Visible height in meters (orthographic) |
| `near`, `far` | Clip planes |
| `dof` | `{ enabled, focusDistance?, aperture }`: depth of field. No `focusDistance` = focus on `target`. `aperture` 0..1 (0.2–0.4 subtle). Everything within ±3% of the focus distance stays sharp |

`set_camera { frame: { shot } }` computes `position` and `target` for you from the devices' real bounds. The stored scene keeps only the result.

## Lights

| `type` | Fields (besides `id`, `color`, `intensity`) |
|---|---|
| `ambient` | – |
| `hemisphere` | `groundColor` |
| `directional` | `position`, `target`, `castShadow`, `shadow { softness, bias, mapSize }` |
| `point` | `position`, `distance`, `decay`, `castShadow`, `shadow` |
| `spot` | `position`, `target`, `angle`, `penumbra`, `distance`, `decay`, `castShadow`, `shadow` |

Shadows are soft (variance shadow maps); `softness` is the blur radius.

## Nodes

All 3D nodes share `id`, `name`, `parent`, `transform { position, rotation, scale }`, `visible`, `opacity`, `castShadow`, `receiveShadow`. `parent` attaches a node to a group (or any 3D node); transforms are then relative to it, and opacity multiplies down the hierarchy.

### `device`

| Field | Meaning |
|---|---|
| `model` | Device ID (see [catalog](catalog.md)) |
| `color` | A named variant of the model, or any hex color |
| `material` | Optional body material override |
| `lidAngle` | Laptops: 0 closed, 90 upright, 180 flat (default ≈110) |
| `screen.source` | `{ type: 'image', asset }`, `{ type: 'video', asset, loop, offset }` or `{ type: 'color', color }` |
| `screen.fit` | `cover` (default, fills the screen), `contain`, `fill` |
| `screen.focus` | For `cover`: which part stays visible. Default `[0.5, 0]` keeps the top, which is right for app screenshots |
| `screen.crop` | `{ x, y, width, height }`, normalized, applied before fitting |
| `screen.rotation` | 0, 90, 180, 270 |
| `screen.brightness` | 0..3 (animate from 0 for a "screen on" effect) |
| `screen.glare` | 0..1 reflection on the display glass |
| `screen.background` | Fill around a `contain` image |

Screens are unlit: your screenshot's colors come out exactly as designed. Video screens are pre-decoded and frame *n* of the scene shows the clip frame at `offset + n / fps` (looping if `loop`).

### `plane`

A floor (faces +Y) or, rotated `[90, 0, 0]`, a wall. `size` is `[width, depth]` in meters. `material` is usually one of:

| Material | Use |
|---|---|
| `{ type: 'shadowCatcher', opacity }` | Invisible floor that only shows shadows, over any background |
| `{ type: 'reflective', strength, blur, fade, shadowOpacity }` | Invisible floor with a soft mirror image and shadows (glossy tabletop) |
| `{ type: 'pbr', color, roughness, metalness, … }` | A visible surface |

### `primitive`

`shape`: `box`, `sphere`, `cylinder`, `cone`, `torus`, `capsule`; `size` in meters (see the schema description per shape); `cornerRadius` for boxes; a `material`. For props and simple set dressing.

### `group`

An empty transform. Parent other nodes to it to move, turn or fade them together. `apply_motion { target: 'all' }` creates one called `arrangement`; the `circle` layout creates `carousel`.

### `text2d`

2D text drawn over the render (never lit, always crisp).

| Field | Meaning |
|---|---|
| `content` | Text, with `{{variable}}` placeholders |
| `font` | `Inter` (bundled), a generic family (`sans-serif`, `serif`, …), or the family name of an imported font asset |
| `size` | Pixels at the canvas resolution (scales with the output size) |
| `weight`, `color`, `align`, `letterSpacing` (em), `lineHeight`, `rotation` | Styling |
| `anchor` | Where the block sits, normalized `[x, y]` |
| `maxWidth` | Wrap width as a fraction of the canvas width |

## Materials

`pbr` (`color`, `roughness`, `metalness`, `opacity`, `emissive`, `emissiveIntensity`, `clearcoat`, `clearcoatRoughness`), `shadowCatcher`, `unlit` (flat color), `reflective` (planes only). Inline on a node, or defined once in `materials` and referenced by ID.

## Assets

```json
"assets": { "home": { "type": "image", "path": "design/home.png", "width": 1179, "height": 2556, "hash": "sha256:…" } }
```

`type` is `image`, `video`, `font` or `model`. `path` is relative to the workspace. Tools that take a screen or background accept a path and import it for you (the asset ID comes from the file name).

## Animation

A track animates one property of one target:

```json
{
  "target": "phone",
  "property": "rotation",
  "interpolation": "auto",
  "keyframes": [
    { "t": 0, "value": [0, -18, 0], "easing": "easeInOutSine" },
    { "t": 5, "value": [0, 18, 0] }
  ]
}
```

- `target`: a node ID, a light ID, or `camera`.
- `easing` applies to the segment that **starts** at that keyframe: `linear`, `step`, `easeIn`, `easeOut`, `easeInOut`, the `Quad`/`Cubic`/`Sine`/`Expo` variants, `easeOutBack`, or `{ "cubicBezier": [x1, y1, x2, y2] }`.
- `interpolation`: `auto` (spline for camera paths with 3+ keys, linear otherwise), `linear` (Euler degrees lerp, so `[0,0,0] → [0,360,0]` is a full spin), `spline` (Catmull-Rom through vec3 keys), `slerp` (shortest-path rotation).
- Before the first key the first value holds; after the last, the last value holds.

Animatable properties (also served as `devicewrapper://animatable`):

| Target | Properties |
|---|---|
| Any 3D node | `position`, `rotation`, `scale`, `opacity`, `visible` |
| Device | + `screen.brightness`, `screen.glare`, `lidAngle` |
| Text | `opacity`, `visible`, `anchor`, `rotation`, `size`, `color` |
| Camera | `position`, `target`, `roll`, `fov`, `orthoHeight`, `dof.focusDistance`, `dof.aperture` |
| Light | `intensity`, `color`; plus `position`/`target` (directional, point, spot), `groundColor` (hemisphere), `angle`/`penumbra` (spot) |

Motion presets (`apply_motion`) just write tracks like these.

## Effects

| `type` | Fields |
|---|---|
| `vignette` | `strength`, `color` |
| `bloom` | `strength`, `threshold`, `radius` |
| `fog` | `color`, `near`, `far` (meters from the camera) |
| `grain` | `amount` (seeded, deterministic per frame) |

One of each type at most.

## Localization

`variables` holds the base values for `{{name}}` placeholders; `locales` holds per-locale overrides. Rendering with `locale: 'es'` uses `locales.es` over `variables`. `{{locale}}` is always defined. Validation warns about undefined variables, missing translations, and scripts the bundled font doesn't cover (those fall back to system fonts; import a font for identical results on every machine).

## Validation

`validate_scene` (and every mutating tool) reports errors and warnings with a code, a message, the JSON path and a hint: unknown assets or models, bad track paths, keyframes after the timeline end, odd video dimensions, unsupported features, and so on. Rendering refuses scenes with errors.
