# Rendering

## Pipeline

```
scene JSON ──► core: validate, resolve assets, evaluate the timeline at frame n ──► FrameState (plain data)
                                                                                      │
                     headless Chromium page (Three.js bundle) ◄───────────────────────┘
                       1. build the 3D scene once per scene (devices are procedural meshes)
                       2. apply the FrameState: transforms, opacity, lid angle, lights, camera, video frame
                       3. WebGL: shadows, environment reflections, mirror floor
                       4. post: depth of field, bloom
                       5. 2D composite: background ▸ 3D ▸ vignette/grain ▸ text
                                                                                      │
Node ◄─────────────────────────────────── RGBA pixels ◄──────────────────────────────┘
  stills: sharp (Lanczos downscale from the supersampled buffer) ─► PNG / JPEG / WebP
  video:  raw frames piped into FFmpeg stdin ─► MP4 (H.264) / WebM (VP9, alpha) / MOV (ProRes 4444, alpha)
```

- **All timing is computed in Node.** The page never reads a clock; it draws exactly the `FrameState` it's given. Frame *n* is at `n / fps`.
- **Chromium is driven over a DevTools pipe**, not a WebSocket, with a minimal client. (Playwright's page layer kept a copy of every frame it transferred, about 8 MB per 1080p frame.) The browser can only reach a loopback HTTP server on a random port behind a secret path; every other host is blocked with `--host-resolver-rules`.
- **Screens are unlit**, so screenshots keep their exact colors. Reflections on the display glass are a separate additive layer scaled by `screen.glare`.
- **Backgrounds and text are 2D**, composited with the 3D render. Gradients and the vignette are computed per pixel in JavaScript with a hashed dither (Skia's own gradient dithering differed between the first and later draws, which broke determinism).
- **Screen and background videos are pre-decoded** with FFmpeg into frame images at the scene fps, then bound per frame. Seeking `<video>` elements frame by frame is not reliable.
- **Crash recovery:** if the page crashes or hangs, the renderer restarts it, rebuilds the scene and retries the frame. A video that hit a crash is identical to one that didn't.

## Determinism

`DEVICEWRAPPER_RENDER_MODE=deterministic` (the default) uses SwiftShader, Chromium's CPU WebGL, so the same scene gives the same pixels on any machine with the same devicewrapper version. Golden tests compare renders pixel by pixel. Nothing that affects pixels uses randomness or the clock: grain and dithering are seeded from the scene `seed` and the frame number, IDs are deterministic, and scene JSON is canonical.

`fast` mode uses the GPU when Chromium can get one. It's quicker but output can differ slightly between machines.

## Performance

CPU rendering is the price of determinism. Rough numbers on a 2-core machine:

| Output | Time |
|---|---|
| First render after the server starts | +10–20 s (Chromium start, shader compile) |
| 1080p still, supersample 2 | 3–10 s |
| Video frame, 1080p, supersample 1 | ~1–1.5 s |
| Depth of field, bloom, a mirror floor, soft shadows | each adds noticeably |

Tips:

- Draft with `render_preview` (small, fast), then render the final.
- For video drafts use `supersample: 1` and a small `width` (480–640). Final 1080p videos take minutes.
- Softer shadows are cheaper: the shadow map shrinks as `softness` grows.
- Up to `DEVICEWRAPPER_MAX_CONCURRENT_RENDERS` jobs run in parallel (default 2).

## Stills

`png` (default), `jpeg`, `webp`. `supersample` (default 2) renders at N× and downscales with a Lanczos filter for clean edges. `time` picks the moment on the timeline.

## Video

| Format | Codec | Alpha | Use |
|---|---|---|---|
| `mp4` | H.264, yuv420p, `+faststart` | no | Web, social, anything |
| `webm` | VP9 | yes (`transparent: true`) | Web with transparency |
| `mov` | ProRes 4444 | yes | Editing in Final Cut / Premiere / Resolve |

Frames stream straight into FFmpeg; nothing is buffered in memory, so long 4K renders use flat memory. `start`/`end` render part of the timeline (`end` is exclusive). H.264 needs even dimensions; odd sizes are padded by one pixel with a warning. Formats without alpha render opaque with a `NO_ALPHA` warning if you ask for transparency.

## Transparency

Set `background: { type: 'transparent' }` (or `transparent: true` on the render) and use PNG, WebP, WebM or MOV. Shadows and the mirror floor stay: they're drawn with alpha, so they sit correctly over whatever you place the image on. Any style can be rendered transparent; `product-white` + `transparent: true` gives a clean cut-out with a soft shadow.

## Effects and look

| Feature | How it's done |
|---|---|
| Soft shadows | Variance shadow maps; `shadow.softness` is the blur radius |
| Environment reflections | Procedural environments (`studio`, `soft`, `softbox`, `sunset`) prefiltered with PMREM, so no HDR files ship |
| Reflective floor | A mirror render at half resolution, blurred over a matching mip level (`blur`), faded with height (`fade`), drawn with alpha over the background |
| Depth of field | Depth pass + fixed-kernel gather by circle of confusion; farther samples never bleed onto nearer sharp edges; image backgrounds are blurred to match |
| Bloom | Soft-knee bright pass, two blur levels at reduced resolution, added back |
| Vignette, grain | 2D, per pixel, seeded |
| Fog | Three.js fog, `near`/`far` in meters from the camera |

## Text and fonts

Text is drawn on the 2D canvas with Inter (bundled; covers Latin, Cyrillic, Greek and Vietnamese). Other scripts (CJK, Arabic, Hebrew, Devanagari, Thai, …) fall back to the machine's system fonts; validation warns `SYSTEM_FONT_FALLBACK` because the result can differ between machines. For identical output everywhere, import a font file (`import_asset` with a TTF/OTF/WOFF) and use its family name as `font`. The Docker image includes Noto CJK and emoji fonts.

## Limits

Configured maximums (resolution, duration, asset sizes) are checked before rendering. Rendering refuses scenes with validation errors, and reports them with the path and a hint.
