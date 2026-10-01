# Templates and custom devices

Templates, styles, lighting, shots and device models are data files, not code. The built-in ones live in `packages/core/assets/`; the [catalog](catalog.md) lists them all. You can add your own templates and devices per workspace without touching devicewrapper.

## Templates

A template is a saved `compose_scene` brief with slots for screenshots and text. Agents list them with `list_templates` and use them with:

```json
{ "template": "phone-trio", "screens": ["design/a.png", "design/b.png", "design/c.png"], "style": "mint" }
```

Any other brief field passed alongside `template` overrides the template's value (`style`, `preset`, `duration`, `camera`, `motion`, `text`, …).

### Writing one

Put a JSON file in `<workspace>/.devicewrapper/templates/`. It's picked up on the next call; a template with the same `name` as a built-in one replaces it.

```json
{
  "name": "launch-trio",
  "title": "Launch trio",
  "description": "Three phones in an arc on glossy black, headline on top, slow turn. For launch announcements.",
  "screens": 3,
  "variables": ["headline"],
  "brief": {
    "preset": "1080p",
    "style": "glossy-dark",
    "layout": "arc",
    "devices": [
      { "model": "phone-modern", "color": "midnight", "screen": "{{screen1}}" },
      { "model": "phone-modern", "color": "midnight", "screen": "{{screen2}}" },
      { "model": "phone-modern", "color": "midnight", "screen": "{{screen3}}" }
    ],
    "text": [{ "content": "{{headline}}", "position": "top" }],
    "motion": [{ "preset": "slow-turn", "target": "all", "amount": 10 }],
    "duration": 6
  }
}
```

| Field | Meaning |
|---|---|
| `name` | ID used in `compose_scene { template }` |
| `title`, `description` | Shown to the agent by `list_templates`; say what it's for, it guides the choice |
| `screens` | How many screenshots it expects: `{{screen1}}` … `{{screenN}}` |
| `variables` | Text variables it uses. Callers pass them in `variables` (and per-locale values in `locales`) |
| `brief` | A `compose_scene` brief (all fields are documented in [tools.md](tools.md#compose_scene)) |

If a caller passes fewer screenshots than slots, the missing `{{screenN}}` values are dropped and those devices show a plain screen (the result notes which). Text variables that aren't passed stay as `{{name}}` in the scene, and validation warns about them.

Brief fields in short:

| Field | Meaning |
|---|---|
| `devices` | 1–12 of `{ model, color?, screen?, lidAngle? }` |
| `layout`, `layoutOptions` | Arrangement (`hero`, `row`, `arc`, `fan`, `stack`, `grid`, `circle`, `showcase`) and `{ spacing, angle, depth, columns, tilt }` |
| `style` | A style from the catalog |
| `camera` | `{ shot, focalLength, padding, shift, dof }` |
| `text` | `[{ content, position, role?, size?, weight?, color?, font? }]`; the camera leaves room for it |
| `motion` | Preset name, `{ preset, target, start, duration, amount, easing }`, or a list |
| `preset` / `canvas` / `duration` | Output size and timeline length |
| `variables`, `locales` | Text values and translations |
| `render` | Default output settings |

Composition is deterministic: the same brief gives the same scene.

## Saved compositions and movements

Briefs describe a setup; they can't hold hand-made keyframes. When a composition is worth keeping as it is (its camera moves, timing and look), save it from the scene with `save_template`. Two more template kinds hold those:

| Kind | Saved with | Holds | Reused with |
|---|---|---|---|
| `brief` | written by hand (above) | a `compose_scene` brief | `compose_scene { template, screens }` |
| `scene` | `save_template { sceneId, name }` | the whole scene: devices, look, camera, every keyframe | `compose_scene { template, screens, variables }` |
| `motion` | `save_template { sceneId, name, kind: 'motion', range: [t0, t1] }` | one movement: camera, one device and text tracks over a time window | `apply_motion { sceneId, clip, start, target? }` |

**Screenshots are per project, motion is reused.** In a scene template each device screen becomes a `{{screenN}}` slot (numbered in node order) and each text becomes a `{{variable}}` named after its node, with the original text as the default. Its other screen settings (fit, focus, glare) are kept. A scene template takes only `name`, `preset`, `canvas`, `duration`, `render`, `style`, `variables` and `locales` as overrides; refine the rest after composing.

**Movements are relative.** A motion clip stores camera points in the device's own frame, in units of its screen height, and device position and rotation as offsets from its base pose. So a clip saved on a phone at one angle plays the same on a phone (or tablet) placed anywhere. It replaces only its own time window on each track, so clips chain: a spin at 0 s, a punch-in at 0.75 s, a pull-out at 1.5 s. Text tracks are replayed on the target scene's text nodes in order (`text1`, `text2`, …) and skipped if there are fewer.

Close-ups land on the same part of the screen as in the original (for example the top third). To aim them at a different spot of another app's screen, use the `focus` motion: `apply_motion { preset: 'focus', target: 'phone', point: [0.5, 0.6], start: 0.75 }`.

### Where templates live

| Scope | Folder | Seen by |
|---|---|---|
| `builtin` | `packages/core/assets/templates/` | everyone |
| `global` | `~/.devicewrapper/templates/` (`DEVICEWRAPPER_TEMPLATES_DIR` or `templatesDir` in config.json to change it) | every workspace on this machine |
| `project` | `<workspace>/.devicewrapper/templates/` | this workspace |

A template with the same name in a later scope wins: project over global over built-in. `list_templates` shows each template's `kind` and `scope`.

A scene template that still references a file other than a screenshot (a background image, a font) warns when saved: that file only resolves in a workspace that has it.

## Styles, lighting presets and shots

Built-in only for now (`packages/core/assets/presets/styles.json`, `lighting.json`, `shots.json`). A style sets the background, a lighting preset (lights + environment), an optional environment override, effects, a floor, a text color and suggested device colors. To make a look reusable per project, put it in a template's brief, or apply a style and adjust it with `set_background` / `set_lights` / `set_effects`.

## Custom devices

Put a device definition in `<workspace>/.devicewrapper/devices/<id>.json`. The file name must match `id`. It shows up in `add_device`, `compose_scene` and the `devicewrapper://devices` resource. Models are built procedurally from these dimensions, so a definition is all it takes.

All sizes are in meters. The simplest form is `slab` (phones, tablets, e-readers):

```json
{
  "id": "phone-compact",
  "name": "Compact phone",
  "category": "smartphone",
  "form": "slab",
  "description": "Small 5.4-inch phone with a notch-free display and a single camera. 64 x 131 x 7.6 mm.",
  "body": { "width": 0.064, "height": 0.131, "depth": 0.0076, "cornerRadius": 0.0095, "edgeRadius": 0.0008 },
  "screen": { "width": 0.0585, "height": 0.1255, "cornerRadius": 0.0078, "offset": [0, 0], "pixels": [1080, 2340] },
  "bezelColor": "#050505",
  "cutout": { "type": "punch", "width": 0.004, "height": 0.004, "offsetY": 0.003 },
  "cameraBump": {
    "width": 0.014, "height": 0.014, "depth": 0.001, "cornerRadius": 0.004,
    "position": [-0.02, 0.05],
    "lenses": [{ "position": [0, 0], "diameter": 0.009 }]
  },
  "buttons": [
    { "side": "right", "offsetY": 0.035, "length": 0.015, "protrusion": 0.0005, "thickness": 0.003 }
  ],
  "colors": [
    { "name": "graphite", "body": "#2d2e31", "finish": "metal" },
    { "name": "sky", "body": "#bcd4ea", "finish": "matte" }
  ]
}
```

| Part | Notes |
|---|---|
| `body` | Outer size; `cornerRadius` seen from the front, `edgeRadius` rounds the sides |
| `screen` | Visible display size, corner radius, offset from the body center, and native `pixels` (sets the texture resolution and the aspect screenshots are fitted to) |
| `cutout` | Optional: `island` (pill), `notch` or `punch`, measured from the top of the display |
| `cameraBump`, `buttons` | Optional details on the back and sides |
| `colors` | Named variants: `body` color, `finish` (`metal`, `matte`, `glossy`), optional `accent` |

The other forms add their own parts (see `packages/schema/src/device.ts` and the built-in files for complete examples):

- `laptop`: `base` (width, depth, thickness), `lid` (height, thickness, screen), `keyboard`, `trackpad`, `defaultLidAngle`.
- `monitor`: panel, `stand` (foot, neck height, where it attaches).
- `watch`: case, `crown`, `band` (width, length, `curl`), with the band color taken from the variant's `accent`.

A definition that doesn't match the schema is rejected with the exact field at fault. Keep the screen smaller than the body, and look at a new model from a few angles with `render_preview` before relying on it.
