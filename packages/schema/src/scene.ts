import { z } from "zod";
import { Color, Easing, Id, Transform, Vec2, Vec3 } from "./primitives.js";

export const SCHEMA_VERSION = 1 as const;

/* ------------------------------------------------------------------ canvas */

export const Canvas = z
  .object({
    width: z.number().int().min(16).max(7680).default(1920).describe("Output width in pixels."),
    height: z.number().int().min(16).max(7680).default(1080).describe("Output height in pixels."),
    fps: z.number().int().min(1).max(120).default(30).describe("Frames per second for video renders."),
    duration: z.number().min(0).max(600).default(5).describe("Timeline length in seconds. Stills use a single time on it."),
  })
  .describe("Output frame size and timeline length.");
export type Canvas = z.infer<typeof Canvas>;

/* -------------------------------------------------------------- background */

export const GradientStop = z.object({
  color: Color,
  offset: z.number().min(0).max(1).describe("Position along the gradient, 0..1."),
});

export const FitMode = z.enum(["cover", "contain", "fill"]);
export type FitMode = z.infer<typeof FitMode>;

export const Background = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("solid"), color: Color.default("#f2f2f4") }),
    z.object({
      type: z.literal("gradient"),
      kind: z.enum(["linear", "radial"]).default("linear"),
      angle: z.number().default(180).describe("Linear only. Degrees; 180 = top to bottom, 90 = left to right."),
      center: Vec2.default([0.5, 0.5]).describe("Radial only. Center in normalized canvas coords (0..1, origin top-left)."),
      radius: z.number().positive().default(0.75).describe("Radial only. Radius relative to the canvas diagonal."),
      stops: z.array(GradientStop).min(2).max(16),
    }),
    z.object({
      type: z.literal("image"),
      asset: Id.describe("Asset ID of an imported image."),
      fit: FitMode.default("cover"),
      color: Color.default("#000000").describe("Fill color visible around a 'contain' image."),
    }),
    z.object({
      type: z.literal("video"),
      asset: Id.describe("Asset ID of an imported video."),
      fit: FitMode.default("cover"),
      loop: z.boolean().default(true),
      offset: z.number().min(0).default(0).describe("Seconds into the clip shown at timeline time 0."),
      color: Color.default("#000000").describe("Fill color visible around a 'contain' video."),
    }),
    z.object({ type: z.literal("transparent") }),
  ])
  .describe("What is drawn behind the 3D scene.");
export type Background = z.infer<typeof Background>;

/* ------------------------------------------------------------- environment */

export const ENVIRONMENT_PRESETS = ["studio", "soft", "softbox", "sunset", "none"] as const;
export const Environment = z
  .object({
    preset: z
      .enum(ENVIRONMENT_PRESETS)
      .default("studio")
      .describe("Image-based lighting and reflections: studio (bright room), soft (diffuse room), softbox (dark room with light strips — crisp highlights on glossy/dark devices), sunset (warm low sun, cool sky), none."),
    intensity: z.number().min(0).max(10).default(1),
    rotation: z.number().default(0).describe("Rotation of the environment around Y, degrees."),
  })
  .describe("Environment lighting (reflections on glass and metal come from here).");
export type Environment = z.infer<typeof Environment>;

/* ------------------------------------------------------------------ camera */

export const DepthOfField = z.object({
  enabled: z.boolean().default(false),
  focusDistance: z.number().positive().optional().describe("Meters from camera. Omit to focus on the camera target."),
  aperture: z
    .number()
    .min(0)
    .max(1)
    .default(0.3)
    .describe("Blur strength 0..1: 0.2–0.4 subtle, 0.6–1 strong. Everything within ±3% of the focus distance stays sharp."),
});

export const Camera = z
  .object({
    type: z.enum(["perspective", "orthographic"]).default("perspective"),
    position: Vec3.default([0, 0, 1.2]),
    target: Vec3.default([0, 0, 0]).describe("Point the camera looks at."),
    roll: z.number().default(0).describe("Rotation around the view axis, degrees."),
    fov: z.number().min(1).max(150).default(30).describe("Perspective only. Vertical field of view, degrees."),
    orthoHeight: z.number().positive().default(0.4).describe("Orthographic only. Visible height in meters."),
    near: z.number().positive().default(0.01),
    far: z.number().positive().default(100),
    dof: DepthOfField.default({ enabled: false, aperture: 0.3 }),
  })
  .describe("The single scene camera. Orientation comes from position + target + roll.");
export type Camera = z.infer<typeof Camera>;

/* ------------------------------------------------------------------ lights */

const ShadowSettings = z.object({
  softness: z.number().min(0).max(20).default(4).describe("Shadow blur radius."),
  bias: z.number().default(-0.0005),
  mapSize: z.union([z.literal(512), z.literal(1024), z.literal(2048), z.literal(4096)]).default(2048),
});

const lightBase = {
  id: Id,
  color: Color.default("#ffffff"),
};

export const Light = z
  .discriminatedUnion("type", [
    z.object({ ...lightBase, type: z.literal("ambient"), intensity: z.number().min(0).default(0.3) }),
    z.object({
      ...lightBase,
      type: z.literal("hemisphere"),
      groundColor: Color.default("#444444"),
      intensity: z.number().min(0).default(0.5),
    }),
    z.object({
      ...lightBase,
      type: z.literal("directional"),
      position: Vec3.default([2, 4, 3]),
      target: Vec3.default([0, 0, 0]),
      intensity: z.number().min(0).default(2),
      castShadow: z.boolean().default(true),
      shadow: ShadowSettings.default({ softness: 4, bias: -0.0005, mapSize: 2048 }),
    }),
    z.object({
      ...lightBase,
      type: z.literal("point"),
      position: Vec3.default([1, 1, 1]),
      intensity: z.number().min(0).default(5),
      distance: z.number().min(0).default(0).describe("0 = infinite range."),
      decay: z.number().min(0).default(2),
      castShadow: z.boolean().default(false),
      shadow: ShadowSettings.default({ softness: 4, bias: -0.0005, mapSize: 1024 }),
    }),
    z.object({
      ...lightBase,
      type: z.literal("spot"),
      position: Vec3.default([1, 2, 2]),
      target: Vec3.default([0, 0, 0]),
      intensity: z.number().min(0).default(10),
      angle: z.number().min(1).max(89).default(30).describe("Cone half-angle, degrees."),
      penumbra: z.number().min(0).max(1).default(0.5),
      distance: z.number().min(0).default(0),
      decay: z.number().min(0).default(2),
      castShadow: z.boolean().default(true),
      shadow: ShadowSettings.default({ softness: 4, bias: -0.0005, mapSize: 2048 }),
    }),
  ])
  .describe("A light. IDs share one namespace with nodes.");
export type Light = z.infer<typeof Light>;
export type LightType = Light["type"];

/* --------------------------------------------------------------- materials */

export const Material = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("pbr"),
      color: Color.default("#ffffff"),
      roughness: z.number().min(0).max(1).default(0.5),
      metalness: z.number().min(0).max(1).default(0),
      opacity: z.number().min(0).max(1).default(1),
      emissive: Color.default("#000000"),
      emissiveIntensity: z.number().min(0).default(1),
      clearcoat: z.number().min(0).max(1).default(0),
      clearcoatRoughness: z.number().min(0).max(1).default(0.1),
    }),
    z.object({
      type: z.literal("shadowCatcher"),
      opacity: z.number().min(0).max(1).default(0.35).describe("Darkness of shadows received."),
      color: Color.default("#000000"),
    }),
    z.object({
      type: z.literal("unlit"),
      color: Color.default("#ffffff"),
      opacity: z.number().min(0).max(1).default(1),
    }),
    z.object({
      type: z.literal("reflective"),
      strength: z.number().min(0).max(1).default(0.3).describe("How visible the mirror image is (0–1)."),
      blur: z.number().min(0).max(1).default(0.25).describe("Glossy blur of the reflection (0 = mirror)."),
      fade: z.number().min(0).max(1).default(0.5).describe("How quickly the reflection fades with height (0 = no fade, 1 = only the base is reflected)."),
      color: Color.default("#ffffff").describe("Tint multiplied into the reflection."),
      shadowOpacity: z.number().min(0).max(1).default(0.25).describe("Darkness of shadows received."),
    }),
  ])
  .describe(
    "pbr = physically based surface. shadowCatcher = invisible surface that only shows shadows (for floating objects over a flat background). unlit = flat color. reflective = invisible floor that shows a soft mirror image and shadows over the background (planes only).",
  );
export type Material = z.infer<typeof Material>;

export const MaterialRef = z
  .union([Id, Material])
  .describe("Either the ID of an entry in scene.materials or an inline material.");
export type MaterialRef = z.infer<typeof MaterialRef>;

/* ------------------------------------------------------------------ assets */

export const ASSET_TYPES = ["image", "video", "audio", "font", "model"] as const;
export const Asset = z.object({
  type: z.enum(ASSET_TYPES),
  path: z.string().min(1).describe("Path relative to the workspace root, using '/' separators."),
  hash: z.string().optional().describe("sha256:<hex> of the file contents when imported."),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  duration: z.number().nonnegative().optional().describe("Seconds, for video."),
  fps: z.number().positive().optional(),
  bytes: z.number().int().nonnegative().optional(),
});
export type Asset = z.infer<typeof Asset>;

/* ------------------------------------------------------------------ screen */

export const ScreenSource = z.discriminatedUnion("type", [
  z.object({ type: z.literal("image"), asset: Id.describe("Asset ID of an imported PNG/JPEG/WebP/SVG.") }),
  z.object({
    type: z.literal("video"),
    asset: Id.describe("Asset ID of an imported video."),
    loop: z.boolean().default(true).describe("Loop the clip when the timeline is longer than it."),
    offset: z.number().min(0).default(0).describe("Seconds into the clip shown at timeline time 0."),
  }),
  z.object({ type: z.literal("color"), color: Color }),
]);
export type ScreenSource = z.infer<typeof ScreenSource>;

export const Screen = z
  .object({
    source: ScreenSource.default({ type: "color", color: "#000000" }),
    fit: FitMode.default("cover"),
    focus: Vec2.default([0.5, 0])
      .describe("For 'cover': which part of the image stays visible, normalized [x, y]. Default [0.5, 0] keeps the top (right for app screenshots)."),
    crop: z
      .object({
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
        width: z.number().gt(0).max(1),
        height: z.number().gt(0).max(1),
      })
      .optional()
      .describe("Normalized crop of the source applied before fitting."),
    rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),
    brightness: z.number().min(0).max(3).default(1),
    glare: z.number().min(0).max(1).default(0.25).describe("Strength of environment reflections on the screen glass."),
    background: Color.default("#000000").describe("Fill color around a 'contain' image."),
  })
  .describe("What the device screen shows.");
export type Screen = z.infer<typeof Screen>;
export type ScreenInput = z.input<typeof Screen>;

/* ------------------------------------------------------------------- nodes */

const spatialBase = {
  id: Id,
  name: z.string().max(200).optional(),
  parent: Id.optional().describe("ID of a group (or any 3D node) this node is attached to."),
  transform: Transform.default({ position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }),
  visible: z.boolean().default(true),
  opacity: z.number().min(0).max(1).default(1),
  castShadow: z.boolean().default(true),
  receiveShadow: z.boolean().default(false),
};

export const DeviceNode = z.object({
  ...spatialBase,
  kind: z.literal("device"),
  model: z.string().min(1).describe("Device model ID, e.g. 'phone-modern'. See the devices resource."),
  color: z.string().optional().describe("Named color variant of the model (e.g. 'black') or a hex color. Defaults to the model's first variant."),
  material: MaterialRef.optional().describe("Overrides the device body material."),
  lidAngle: z.number().min(0).max(180).optional().describe("Laptops only: how far the lid is open, degrees (0 closed, 90 upright, 180 flat). Default: the model's (≈110)."),
  screen: Screen.default({
    source: { type: "color", color: "#000000" },
    fit: "cover",
    focus: [0.5, 0],
    rotation: 0,
    brightness: 1,
    glare: 0.25,
    background: "#000000",
  }),
});

export const PlaneNode = z.object({
  ...spatialBase,
  kind: z.literal("plane"),
  size: Vec2.default([10, 10]).describe("Width (X) and depth (Z) in meters. The plane faces +Y (a floor); rotate [90,0,0] for a wall facing the camera."),
  material: MaterialRef.default({
    type: "pbr",
    color: "#ffffff",
    roughness: 0.9,
    metalness: 0,
    opacity: 1,
    emissive: "#000000",
    emissiveIntensity: 1,
    clearcoat: 0,
    clearcoatRoughness: 0.1,
  }),
  castShadow: z.boolean().default(false),
  receiveShadow: z.boolean().default(true),
});

export const PRIMITIVE_SHAPES = ["box", "sphere", "cylinder", "cone", "torus", "capsule"] as const;
export const PrimitiveNode = z.object({
  ...spatialBase,
  kind: z.literal("primitive"),
  shape: z.enum(PRIMITIVE_SHAPES),
  size: Vec3.default([0.1, 0.1, 0.1]).describe(
    "Meters. box: [w,h,d]. sphere: [diameter,-,-]. cylinder/cone/capsule: [diameter, height, -]. torus: [outer diameter, tube diameter, -].",
  ),
  cornerRadius: z.number().min(0).default(0).describe("Box only. Rounded edge radius in meters."),
  material: MaterialRef.default({
    type: "pbr",
    color: "#cccccc",
    roughness: 0.5,
    metalness: 0,
    opacity: 1,
    emissive: "#000000",
    emissiveIntensity: 1,
    clearcoat: 0,
    clearcoatRoughness: 0.1,
  }),
});

export const GroupNode = z.object({ ...spatialBase, kind: z.literal("group") });

export const Text2dNode = z
  .object({
    id: Id,
    name: z.string().max(200).optional(),
    kind: z.literal("text2d"),
    content: z.string().max(2000).describe("Text. Use {{variable}} placeholders for localized values."),
    font: z.string().default("Inter").describe("Font family. Bundled: Inter. Imported font assets can be referenced by family name."),
    size: z.number().positive().default(64).describe("Font size in pixels at the canvas resolution."),
    weight: z.number().int().min(100).max(900).default(600),
    color: Color.default("#111111"),
    align: z.enum(["left", "center", "right"]).default("center"),
    anchor: Vec2.default([0.5, 0.12]).describe("Where the text block is placed, normalized canvas coords (0..1, origin top-left)."),
    rotation: z.number().default(0).describe("Degrees."),
    letterSpacing: z.number().default(0).describe("Extra spacing between letters, in em."),
    lineHeight: z.number().positive().default(1.15),
    maxWidth: z.number().gt(0).max(1).default(0.8).describe("Wrap width as a fraction of the canvas width."),
    visible: z.boolean().default(true),
    opacity: z.number().min(0).max(1).default(1),
  })
  .describe("2D text drawn over the rendered 3D scene.");

export const Node = z.discriminatedUnion("kind", [DeviceNode, PlaneNode, PrimitiveNode, GroupNode, Text2dNode]);
export type Node = z.infer<typeof Node>;
export type NodeKind = Node["kind"];
export type DeviceNode = z.infer<typeof DeviceNode>;
export type PlaneNode = z.infer<typeof PlaneNode>;
export type PrimitiveNode = z.infer<typeof PrimitiveNode>;
export type GroupNode = z.infer<typeof GroupNode>;
export type Text2dNode = z.infer<typeof Text2dNode>;
export type SpatialNode = Exclude<Node, Text2dNode>;

/* --------------------------------------------------------------- animation */

export const KeyframeValue = z.union([z.number(), z.boolean(), Vec3, Vec2, Color]);
export type KeyframeValue = z.infer<typeof KeyframeValue>;

export const Keyframe = z.object({
  t: z.number().min(0).describe("Time in seconds."),
  value: KeyframeValue,
  easing: Easing.default("linear"),
});
export type Keyframe = z.infer<typeof Keyframe>;

export const Track = z
  .object({
    target: z.string().min(1).describe("Node ID, light ID, or 'camera'."),
    property: z.string().min(1).describe("Animatable property path, e.g. 'position', 'rotation', 'opacity', 'fov', 'intensity'."),
    interpolation: z.enum(["auto", "linear", "spline", "slerp"]).default("auto").describe(
      "'auto': spline for camera position/target with 3+ keyframes, linear otherwise. 'linear': straight lerp (rotations lerp Euler degrees, so [0,0,0] -> [0,360,0] is a full spin). 'spline': smooth Catmull-Rom curve through vec3 keyframes. 'slerp': rotations only, shortest-path quaternion interpolation.",
    ),
    keyframes: z.array(Keyframe).min(1).max(1000),
  })
  .describe("Keyframes for one property of one target.");
export type Track = z.infer<typeof Track>;

export const Animation = z.object({
  tracks: z.array(Track).default([]),
});
export type Animation = z.infer<typeof Animation>;

/* ----------------------------------------------------------------- effects */

export const Effect = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("vignette"),
    strength: z.number().min(0).max(1).default(0.35),
    color: Color.default("#000000"),
  }),
  z.object({
    type: z.literal("bloom"),
    strength: z.number().min(0).max(3).default(0.4),
    threshold: z.number().min(0).max(1).default(0.85),
    radius: z.number().min(0).max(1).default(0.4),
  }),
  z.object({
    type: z.literal("fog"),
    color: Color.default("#000000"),
    near: z.number().min(0).default(2),
    far: z.number().positive().default(10),
  }),
  z.object({
    type: z.literal("grain"),
    amount: z.number().min(0).max(1).default(0.04).describe("Film grain. Deterministic per frame (seeded)."),
  }),
]);
export type Effect = z.infer<typeof Effect>;
export type EffectType = Effect["type"];

/* ------------------------------------------------------------------- audio */

export const AudioCue = z
  .object({
    t: z.number().min(0).describe("When the sound starts, seconds on the timeline."),
    sound: z
      .string()
      .regex(/^([a-z0-9-]+\/)?[a-z0-9-]+$/, "A sound is a cue name ('swipe') or pack/cue ('cinematic/swipe')")
      .optional()
      .describe("Built-in sound: a cue name like 'swipe' (from the scene's pack) or 'pack/cue' like 'cinematic/swipe'."),
    asset: Id.optional().describe("Or an imported audio asset (MP3, WAV, M4A, OGG, FLAC)."),
    gain: z.number().min(0).max(4).default(1).describe("Loudness multiplier; 1 = as designed."),
    source: z.string().max(200).optional().describe("Who added it, e.g. 'motion:rise:phone'. Motion presets replace their own cues when re-applied."),
  })
  .refine((c) => (c.sound === undefined) !== (c.asset === undefined), { message: "A cue needs exactly one of 'sound' or 'asset'." })
  .describe("One sound effect on the timeline.");
export type AudioCue = z.infer<typeof AudioCue>;

export const Music = z
  .object({
    asset: Id.describe("Imported audio (or video with sound) asset."),
    volume: z.number().min(0).max(4).default(0.6),
    offset: z.number().min(0).default(0).describe("Seconds into the file at timeline time 0."),
    loop: z.boolean().default(true),
    fadeIn: z.number().min(0).default(0.5).describe("Seconds."),
    fadeOut: z.number().min(0).default(1).describe("Seconds, at the end of the rendered range."),
  })
  .describe("A background track under the sound effects.");
export type Music = z.infer<typeof Music>;

export const SceneAudio = z
  .object({
    enabled: z.boolean().default(true).describe("Include sound in video renders."),
    pack: z.string().default("minimal").describe("Sound pack for cues given by name (see the sounds resource). 'minimal' is dry and subtle; 'cinematic' has deeper impacts."),
    volume: z.number().min(0).max(4).default(1).describe("Master volume for effects and music."),
    cues: z.array(AudioCue).max(500).default([]),
    music: Music.optional(),
  })
  .describe("Sound for video renders: effects on the timeline (motion presets add them) and optional music. Stills ignore it.");
export type SceneAudio = z.infer<typeof SceneAudio>;

/* ------------------------------------------------------------------ render */

export const STILL_FORMATS = ["png", "jpeg", "webp"] as const;
export const VIDEO_FORMATS = ["mp4", "webm", "mov"] as const;
export const OutputFormat = z.enum([...STILL_FORMATS, ...VIDEO_FORMATS]);
export type OutputFormat = z.infer<typeof OutputFormat>;

export const RenderSettings = z
  .object({
    format: OutputFormat.default("png"),
    quality: z.number().int().min(1).max(100).default(90).describe("JPEG/WebP quality, or video quality (higher = better, larger)."),
    transparent: z.boolean().default(false).describe("Transparent background. PNG/WebP stills, WebM (VP9 alpha) or MOV (ProRes 4444) video."),
    supersample: z.number().int().min(1).max(4).default(2).describe("Render at N× resolution and downscale for smoother edges."),
    time: z.number().min(0).default(0).describe("Timeline time (seconds) used for still renders."),
  })
  .describe("Default output settings. Render calls can override any of these.");
export type RenderSettings = z.infer<typeof RenderSettings>;

/* ------------------------------------------------------------------- scene */

export const Scene = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
    id: Id,
    name: z.string().max(200).optional(),
    description: z.string().max(4000).optional(),
    seed: z.number().int().min(0).max(2 ** 31 - 1).default(1).describe("Seed for any procedural randomness (e.g. grain)."),
    canvas: Canvas.default({ width: 1920, height: 1080, fps: 30, duration: 5 }),
    background: Background.default({ type: "solid", color: "#f2f2f4" }),
    environment: Environment.default({ preset: "studio", intensity: 1, rotation: 0 }),
    camera: Camera.default({
      type: "perspective",
      position: [0, 0, 1.2],
      target: [0, 0, 0],
      roll: 0,
      fov: 30,
      orthoHeight: 0.4,
      near: 0.01,
      far: 100,
      dof: { enabled: false, aperture: 0.3 },
    }),
    lights: z.array(Light).default([]),
    nodes: z.array(Node).default([]),
    materials: z.record(Id, Material).default({}),
    assets: z.record(Id, Asset).default({}),
    animation: Animation.default({ tracks: [] }),
    effects: z.array(Effect).default([]),
    audio: SceneAudio.default({ enabled: true, pack: "minimal", volume: 1, cues: [] }),
    variables: z.record(z.string(), z.string()).default({}).describe("Base text variables used by {{name}} placeholders."),
    locales: z
      .record(z.string().regex(/^[a-zA-Z]{2,3}([-_][a-zA-Z0-9]{2,8})*$/, "Locale codes look like 'en', 'es', 'pt-BR'"), z.record(z.string(), z.string()))
      .default({})
      .describe("Per-locale variable overrides, e.g. { es: { headline: 'Hola' } }."),
    defaultLocale: z.string().default("en"),
    render: RenderSettings.default({ format: "png", quality: 90, transparent: false, supersample: 2, time: 0 }),
  })
  .describe("A complete devicewrapper scene. Units are meters and degrees.");

export type Scene = z.infer<typeof Scene>;
export type SceneInput = z.input<typeof Scene>;
