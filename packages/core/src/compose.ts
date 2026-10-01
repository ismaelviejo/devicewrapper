import { Id, type Scene } from "@devicewrapper/schema";
import { z } from "zod";
import type { DeviceRegistry } from "./devices.js";
import { DwError, schemaError } from "./errors.js";
import { ensureAsset } from "./assets.js";
import { setAudio } from "./audio.js";
import { LAYOUT_NAMES, applyLayout, type LayoutName } from "./layout.js";
import { MOTION_NAMES, applyMotion } from "./motion.js";
import { addNode, createScene, setCamera, setVariables, updateNode, updateScene } from "./ops.js";
import { CAMERA_SHOTS } from "./presets.js";
import { STYLES, STYLE_NAMES, applyStyle } from "./style.js";
import type { Workspace } from "./workspace.js";

/* ----------------------------------------------------------- canvas sizes */

export const CANVAS_PRESETS = {
  "720p": [1280, 720],
  "1080p": [1920, 1080],
  "1440p": [2560, 1440],
  "4k": [3840, 2160],
  square: [1080, 1080],
  "square-2k": [2048, 2048],
  portrait: [1080, 1920],
  "portrait-4k": [2160, 3840],
  "app-store-6.9": [1320, 2868],
  "app-store-ipad": [2064, 2752],
  "instagram-portrait": [1080, 1350],
  "og-image": [1200, 630],
} as const;
export type CanvasPresetName = keyof typeof CANVAS_PRESETS;
export const CANVAS_PRESET_NAMES = Object.keys(CANVAS_PRESETS) as CanvasPresetName[];

/* ------------------------------------------------------------------ brief */

const TEXT_POSITIONS = {
  top: { anchor: [0.5, 0.1], align: "center" },
  bottom: { anchor: [0.5, 0.9], align: "center" },
  center: { anchor: [0.5, 0.5], align: "center" },
  "top-left": { anchor: [0.07, 0.1], align: "left" },
  "top-right": { anchor: [0.93, 0.1], align: "right" },
  "bottom-left": { anchor: [0.07, 0.9], align: "left" },
  "bottom-right": { anchor: [0.93, 0.9], align: "right" },
} as const;
type TextPosition = keyof typeof TEXT_POSITIONS;

const MotionSpec = z.object({
  preset: z.enum(MOTION_NAMES as [string, ...string[]]),
  target: z.string().optional().describe("Device ID or 'camera'. Default: all devices (device motions) or the camera."),
  start: z.number().min(0).optional(),
  duration: z.number().positive().optional(),
  amount: z.number().optional(),
  easing: z.string().optional(),
  stagger: z.number().min(0).optional(),
});

export const ComposeBrief = z
  .object({
    id: Id.optional(),
    name: z.string().max(200).optional(),
    concept: z.string().max(4000).optional().describe("Free-text intent, stored as the scene description. The engine does not interpret it."),
    preset: z.enum(CANVAS_PRESET_NAMES as [CanvasPresetName, ...CanvasPresetName[]]).optional().describe("Canvas size preset."),
    canvas: z.object({ width: z.number().int().min(16).max(7680).optional(), height: z.number().int().min(16).max(7680).optional(), fps: z.number().int().min(1).max(120).optional(), duration: z.number().min(0).max(600).optional() }).optional(),
    duration: z.number().min(0).max(600).optional().describe("Timeline length in seconds (shortcut for canvas.duration)."),
    devices: z
      .array(
        z.object({
          model: z.string().default("phone-modern"),
          id: Id.optional(),
          color: z.string().optional().describe("Variant name or hex. Default: the style's suggested color for this kind of device."),
          screen: z.union([z.string(), z.record(z.string(), z.unknown())]).optional().describe("Asset ID or workspace path of a screenshot/recording, or a screen object."),
          lidAngle: z.number().min(0).max(180).optional(),
        }),
      )
      .min(1)
      .max(12),
    layout: z.enum(LAYOUT_NAMES as [LayoutName, ...LayoutName[]]).optional().describe("Default: hero (1 device), arc (2–3 of the same kind), showcase (mixed sizes), row (4–5), grid (6+)."),
    layoutOptions: z.object({ spacing: z.number().optional(), angle: z.number().optional(), depth: z.number().optional(), columns: z.number().int().positive().optional(), tilt: z.number().optional() }).optional(),
    style: z.enum(STYLE_NAMES as [string, ...string[]]).default("light-studio"),
    camera: z
      .object({
        shot: z.enum(CAMERA_SHOTS as [string, ...string[]]).optional(),
        focalLength: z.number().positive().optional(),
        padding: z.number().min(-0.9).max(5).optional().describe("Extra room around the devices (0.15 ≈ 7% margin per side; 1 = they fill half the frame). Default depends on the layout."),
        shift: z.tuple([z.number(), z.number()]).optional().describe("Move the subject in frame: [x, y] fractions of the frame; +y moves it down. Text already shifts it automatically."),
        dof: z.number().min(0).max(1).optional().describe("Depth of field strength (aperture 0..1; 0.2–0.4 subtle, 0.6–1 strong), focused on the camera target."),
      })
      .optional(),
    text: z
      .array(
        z.object({
          content: z.string().max(2000),
          position: z.enum(Object.keys(TEXT_POSITIONS) as [TextPosition, ...TextPosition[]]).default("top"),
          role: z.enum(["headline", "subtitle", "caption"]).optional().describe("Default: headline for the first text at a position, subtitle for the next ones."),
          size: z.number().positive().optional().describe("Pixels at the canvas size. Default scales with the canvas."),
          weight: z.number().int().min(100).max(900).optional(),
          color: z.string().optional(),
          font: z.string().optional(),
        }),
      )
      .optional(),
    variables: z.record(z.string(), z.string()).optional(),
    locales: z.record(z.string(), z.record(z.string(), z.string())).optional(),
    motion: z.union([z.enum(MOTION_NAMES as [string, ...string[]]), MotionSpec, z.array(z.union([z.enum(MOTION_NAMES as [string, ...string[]]), MotionSpec]))]).optional(),
    render: z.record(z.string(), z.unknown()).optional().describe("Default render settings (format, quality, supersample, transparent, time)."),
    sound: z
      .union([z.boolean(), z.string()])
      .optional()
      .describe("Sound effects for motions in videos: true (default, 'minimal' pack), false for silent, or a pack name like 'cinematic'."),
  })
  .describe("Declarative description of a whole scene. Deterministic: the same brief always builds the same scene.");
export type ComposeBrief = z.infer<typeof ComposeBrief>;
export type ComposeBriefInput = z.input<typeof ComposeBrief>;

function defaultLayout(brief: ComposeBrief, devices: DeviceRegistry): LayoutName {
  const n = brief.devices.length;
  if (n === 1) return "hero";
  const cats = new Set(brief.devices.map((d) => devices.get(d.model)?.category ?? "smartphone"));
  if (cats.size > 1) return "showcase";
  if (n <= 3) return "arc";
  if (n <= 5) return "row";
  return "grid";
}

const LAYOUT_CAMERA: Record<LayoutName, { shot: string; focalLength: number; padding: number }> = {
  hero: { shot: "hero", focalLength: 70, padding: 0.22 },
  row: { shot: "front", focalLength: 60, padding: 0.15 },
  arc: { shot: "hero", focalLength: 60, padding: 0.16 },
  fan: { shot: "front", focalLength: 65, padding: 0.18 },
  stack: { shot: "hero", focalLength: 60, padding: 0.18 },
  grid: { shot: "front", focalLength: 60, padding: 0.1 },
  circle: { shot: "high-angle", focalLength: 50, padding: 0.12 },
  showcase: { shot: "hero", focalLength: 55, padding: 0.14 },
};

/**
 * Builds a complete scene from a brief: devices (screens imported), layout, style, text,
 * camera framing, motion and render defaults. Pure composition of the same operations the
 * granular tools use, so the result can be refined afterwards.
 */
export async function composeScene(ws: Workspace, devices: DeviceRegistry, input: unknown, id: string): Promise<Scene> {
  const parsed = ComposeBrief.safeParse(input);
  if (!parsed.success) throw schemaError(parsed.error.issues, "", "Brief");
  const brief = parsed.data;
  const style = STYLES[brief.style]!;

  const canvas: Record<string, number> = { ...(brief.canvas ?? {}) } as Record<string, number>;
  if (brief.preset) {
    const [w, h] = CANVAS_PRESETS[brief.preset];
    canvas.width ??= w;
    canvas.height ??= h;
  }
  if (brief.duration !== undefined) canvas.duration = brief.duration;
  let s = createScene({
    id,
    ...(brief.name ? { name: brief.name } : {}),
    ...(brief.concept ? { description: brief.concept } : {}),
    ...(Object.keys(canvas).length ? { canvas } : {}),
    lighting: "none",
  });

  for (const [i, d] of brief.devices.entries()) {
    const def = devices.require(d.model);
    const node: Record<string, unknown> = { kind: "device", model: d.model };
    if (d.id) node.id = d.id;
    const suggested = style.deviceColors[def.category];
    const colorName = d.color ?? (suggested && def.colors.some((c) => c.name === suggested) ? suggested : undefined);
    if (colorName) node.color = colorName;
    if (d.lidAngle !== undefined) node.lidAngle = d.lidAngle;
    if (d.screen !== undefined) {
      if (typeof d.screen === "string") {
        const r = await ensureAsset(ws, s, d.screen);
        s = r.scene;
        const a = s.assets[r.assetId]!;
        if (a.type !== "image" && a.type !== "video") throw new DwError("ASSET_TYPE_MISMATCH", `devices[${i}].screen '${d.screen}' is a ${a.type}, not an image or video.`);
        node.screen = { source: { type: a.type, asset: r.assetId } };
      } else {
        const scr = { ...d.screen } as Record<string, unknown>;
        const src = scr.source as Record<string, unknown> | undefined;
        if (src && typeof src.asset === "string") {
          const r = await ensureAsset(ws, s, src.asset);
          s = r.scene;
          scr.source = { ...src, asset: r.assetId };
        }
        node.screen = scr;
      }
    }
    s = addNode(s, node, devices).scene;
  }

  const layout = brief.layout ?? defaultLayout(brief, devices);
  s = applyLayout(s, { layout, ...(brief.layoutOptions ?? {}) }, devices);
  s = applyStyle(s, { style: brief.style, recolorText: false }, devices);

  // Text
  const texts = brief.text ?? [];
  const shortSide = Math.min(s.canvas.width, s.canvas.height);
  // Several texts at one position stack (headline, then subtitle below it; bottom texts stack upward).
  const portraitCanvas = s.canvas.height > s.canvas.width;
  const ROLE = {
    headline: { size: portraitCanvas ? 0.085 : 0.066, weight: 700 },
    subtitle: { size: portraitCanvas ? 0.05 : 0.04, weight: 500 },
    caption: { size: portraitCanvas ? 0.032 : 0.026, weight: 500 },
  } as const;
  const stackOffset = new Map<TextPosition, number>();
  const seenAt = new Map<TextPosition, number>();
  for (const t of texts) {
    const pos = TEXT_POSITIONS[t.position];
    const index = seenAt.get(t.position) ?? 0;
    seenAt.set(t.position, index + 1);
    const role = t.role ?? (index === 0 ? (t.position.startsWith("bottom") ? "subtitle" : "headline") : "subtitle");
    const size = t.size ?? Math.round(shortSide * ROLE[role].size);
    // Estimate wrapped lines (average glyph ≈ 0.55 em; text wraps at 86% of the canvas width).
    const perLine = Math.max(1, Math.floor((0.86 * s.canvas.width) / (size * 0.55)));
    const lines = t.content.split("\n").reduce((acc, l) => acc + Math.max(1, Math.ceil(l.length / perLine)), 0);
    const blockH = (size * 1.15 * lines) / s.canvas.height;
    const gap = (size * 0.45) / s.canvas.height;
    const offset = stackOffset.get(t.position) ?? 0;
    const up = t.position.startsWith("bottom") ? -1 : 1;
    // First block centers on the anchor; following blocks start below (or above) the previous one.
    const anchorY = pos.anchor[1] + up * (offset === 0 ? 0 : offset + blockH / 2);
    stackOffset.set(t.position, (offset === 0 ? blockH / 2 : offset + blockH) + gap);
    // Secondary lines are slightly transparent; the first text at a position stays fully opaque.
    const isSub = role !== "headline" && index > 0;
    s = addNode(
      s,
      {
        kind: "text2d",
        content: t.content,
        anchor: [pos.anchor[0], Math.round(anchorY * 10000) / 10000],
        align: pos.align,
        size,
        weight: t.weight ?? ROLE[role].weight,
        color: t.color ?? (isSub ? style.textColor + "b3" : style.textColor),
        ...(t.font ? { font: t.font } : {}),
        maxWidth: 0.86,
      },
      devices,
    ).scene;
  }
  if (brief.variables) s = setVariables(s, { variables: brief.variables });
  for (const [loc, vars] of Object.entries(brief.locales ?? {})) s = setVariables(s, { locale: loc, variables: vars });

  // Camera: frame the devices, leaving room for text.
  const cam = LAYOUT_CAMERA[layout];
  const topCount = texts.filter((t) => t.position.startsWith("top")).length;
  const bottomCount = texts.filter((t) => t.position.startsWith("bottom")).length;
  const hasTop = topCount > 0;
  const hasBottom = bottomCount > 0;
  // Fraction of the frame height each text block needs, measured from the actual text sizes.
  // Fraction of the frame height the text occupies from the top / bottom edge, from the laid-out blocks.
  let roomTop = 0, roomBottom = 0;
  for (const [pos, off] of stackOffset) {
    const a = TEXT_POSITIONS[pos].anchor[1];
    if (pos.startsWith("top")) roomTop = Math.max(roomTop, a + off + 0.02);
    else if (pos.startsWith("bottom")) roomBottom = Math.max(roomBottom, 1 - a + off + 0.02);
  }
  // Shrink the subject to fit in what's left (keeping the layout's own margin), then shift it so the
  // free space sits under/over the text: padding p means content spans 1/(1+p) of the frame.
  const base = 1 / (1 + cam.padding);
  const avail = Math.max(0.3, base - roomTop - roomBottom);
  const shift: [number, number] = brief.camera?.shift ?? [0, (roomTop - roomBottom) / 2];
  const padding = brief.camera?.padding ?? (hasTop || hasBottom ? 1 / avail - 1 : cam.padding);
  s = setCamera(
    s,
    {
      focalLength: brief.camera?.focalLength ?? cam.focalLength,
      frame: { shot: brief.camera?.shot ?? cam.shot, padding, shift },
      ...(brief.camera?.dof ? { patch: { dof: { enabled: true, aperture: brief.camera.dof } } } : {}),
    },
    devices,
  );

  // Motion
  const motions = brief.motion === undefined ? [] : Array.isArray(brief.motion) ? brief.motion : [brief.motion];
  const sound = brief.sound ?? true;
  if (typeof sound === "string") s = setAudio(s, { pack: sound });
  for (const m of motions) {
    const spec = typeof m === "string" ? { preset: m } : m;
    s = applyMotion(s, { ...spec, sound: sound !== false } as never, devices).scene;
  }

  if (brief.render) s = updateScene(s, { render: brief.render });
  return s;
}

/** Replace a device's screen after composition (helper for tools). */
export function setScreen(scene: Scene, id: string, assetId: string, type: "image" | "video", devices: DeviceRegistry): Scene {
  return updateNode(scene, id, { screen: { source: { type, asset: assetId } } }, devices);
}
