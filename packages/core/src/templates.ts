import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Id, type Keyframe, type Scene, type Track, type Vec3 } from "@devicewrapper/schema";
import { z } from "zod";
import { ensureAsset } from "./assets.js";
import { canonicalize } from "./canonical.js";
import { CANVAS_PRESETS, type CanvasPresetName } from "./compose.js";
import { BUILTIN_ASSETS_DIR, type DeviceRegistry } from "./devices.js";
import { DwError, schemaError } from "./errors.js";
import { v3 } from "./math.js";
import { resolveDevice, type MotionResult } from "./motion.js";
import { assetReferences, mergePatch, parseScene, setVariables, updateNode, updateScene } from "./ops.js";
import { sliceTrack, spliceTrack, toLocal, toWorld, vr6, worldPose } from "./pose.js";
import { animatableProperties, findTarget } from "./properties.js";
import { referencedVariables } from "./resolve.js";
import { migrateScene } from "./store.js";
import { applyStyle } from "./style.js";
import type { Workspace } from "./workspace.js";

/**
 * Templates: reusable compositions saved as JSON. Three kinds:
 * - brief: a compose_scene brief with {{screenN}} slots (the built-in templates);
 * - scene: a whole scene, keyframes and all, with each device screen turned into a {{screenN}} slot
 *   and text into {{variables}}, so a composition someone liked replays on any project's screenshots;
 * - motion: one movement (camera + device + text tracks over a time window), stored relative to the
 *   device and its screen size, so it can be dropped onto another scene at any time.
 * Templates live in the built-in assets, a global folder shared by all workspaces, and the workspace.
 */

export type TemplateScope = "builtin" | "global" | "project";
export type TemplateKind = "brief" | "scene" | "motion";

const ClipTrack = z.object({
  role: z.string().regex(/^(camera|device|text[1-9][0-9]*)$/, "role is 'camera', 'device' or 'textN'"),
  property: z.string(),
  relative: z.boolean().default(false).describe("Values are offsets from the target's base pose (device) or device-local, screen-height units (camera)."),
  interpolation: z.enum(["auto", "linear", "spline", "slerp"]).default("auto"),
  keyframes: z.array(z.object({ t: z.number().min(0), value: z.any(), easing: z.any().optional() })).min(1),
});

export const MotionClip = z.object({
  duration: z.number().positive(),
  unit: z.number().positive().describe("Screen height (m) of the device the clip was saved from."),
  tracks: z.array(ClipTrack).min(1),
});
export type MotionClip = z.infer<typeof MotionClip>;

export const TemplateFile = z
  .object({
    name: Id,
    title: z.string(),
    description: z.string(),
    screens: z.number().int().min(0).default(0).describe("How many screenshots the template expects ({{screen1}} … {{screenN}})."),
    variables: z.array(z.string()).default([]).describe("Text variables the template uses."),
    brief: z.record(z.string(), z.unknown()).optional(),
    scene: z.record(z.string(), z.unknown()).optional(),
    motion: MotionClip.optional(),
  })
  .superRefine((t, ctx) => {
    if ([t.brief, t.scene, t.motion].filter((x) => x !== undefined).length !== 1) {
      ctx.addIssue({ code: "custom", message: "A template needs exactly one of 'brief', 'scene' or 'motion'." });
    }
  });
export type TemplateFile = z.infer<typeof TemplateFile>;
export type LoadedTemplate = TemplateFile & { source: string; scope: TemplateScope; kind: TemplateKind };

export function templateKind(t: TemplateFile): TemplateKind {
  return t.brief ? "brief" : t.scene ? "scene" : "motion";
}

/**
 * Loads templates: built-ins first, then each source in order; a later template with the same name wins
 * (project over global over built-in). A bare string source is a project folder.
 */
export function loadTemplates(sources: Array<string | { dir: string; scope: TemplateScope }> = []): Map<string, LoadedTemplate> {
  const out = new Map<string, LoadedTemplate>();
  const all = [{ dir: join(BUILTIN_ASSETS_DIR, "templates"), scope: "builtin" as TemplateScope }, ...sources.map((s) => (typeof s === "string" ? { dir: s, scope: "project" as TemplateScope } : s))];
  for (const { dir, scope } of all) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).sort()) {
      if (!f.endsWith(".json")) continue;
      const path = join(dir, f);
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(path, "utf8"));
      } catch (e) {
        throw new DwError("TEMPLATE_INVALID", `Template ${path} is not valid JSON: ${(e as Error).message}`);
      }
      const r = TemplateFile.safeParse(raw);
      if (!r.success) throw schemaError(r.error.issues, "", `Template ${path}`);
      out.set(r.data.name, { ...r.data, source: path, scope, kind: templateKind(r.data) });
    }
  }
  return out;
}

/** Writes a template file into a templates folder (validated, canonical JSON). */
export function writeTemplate(dir: string, tpl: TemplateFile, overwrite = false): string {
  const parsed = TemplateFile.safeParse(tpl);
  if (!parsed.success) throw schemaError(parsed.error.issues, "", "Template");
  const path = join(dir, `${parsed.data.name}.json`);
  if (existsSync(path) && !overwrite) {
    throw new DwError("TEMPLATE_EXISTS", `A template named '${parsed.data.name}' already exists at ${path}.`, { hint: "Pick another name, or pass overwrite: true." });
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(canonicalize(parsed.data), null, 2) + "\n");
  return path;
}

/* ------------------------------------------------------------------ brief */

function replaceDeep(v: unknown, fn: (s: string) => string | undefined): unknown {
  if (typeof v === "string") return fn(v);
  if (Array.isArray(v)) return v.map((x) => replaceDeep(x, fn)).filter((x) => x !== undefined);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const r = replaceDeep(x, fn);
      if (r !== undefined) o[k] = r;
    }
    return o;
  }
  return v;
}

/**
 * Turns a brief template + screenshots (+ variables and brief overrides) into a brief.
 * {{screenN}} placeholders are replaced; with fewer screens than slots, screens repeat in order.
 * A device whose screen slot has no screenshot at all shows a black screen.
 */
export function expandTemplate(tpl: TemplateFile, screens: string[], variables: Record<string, string> = {}, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  if (!tpl.brief) throw new DwError("WRONG_TEMPLATE_KIND", `Template '${tpl.name}' is a ${templateKind(tpl)} template, not a brief.`);
  const brief = replaceDeep(structuredClone(tpl.brief), (s) => {
    const m = /^\{\{screen(\d+)\}\}$/.exec(s);
    if (!m) return s;
    if (screens.length === 0) return undefined;
    return screens[(Number(m[1]) - 1) % screens.length];
  }) as Record<string, unknown>;
  const merged = mergePatch(brief, overrides) as Record<string, unknown>;
  const vars = { ...((merged.variables as Record<string, string>) ?? {}), ...variables };
  if (Object.keys(vars).length) merged.variables = vars;
  return merged;
}

/* ------------------------------------------------------------------ scene */

const SLOT_RE = /^\{\{screen(\d+)\}\}$/;

export interface SceneTemplateOptions {
  name: string;
  title?: string;
  description?: string;
  /** Turn each text node's content into a {{variable}} named after the node (default true). */
  textVariables?: boolean;
}

/** Snapshots a scene as a scene template: device screens become {{screenN}} slots (in node order). */
export function sceneToTemplate(scene: Scene, opts: SceneTemplateOptions): { template: TemplateFile; warnings: string[] } {
  const s = structuredClone(scene);
  const warnings: string[] = [];
  let slots = 0;
  for (const n of s.nodes) {
    if (n.kind !== "device" || n.screen.source.type === "color") continue;
    slots++;
    (n.screen.source as { asset: string }).asset = `{{screen${slots}}}`;
  }
  for (const [id, a] of Object.entries(s.assets)) {
    if (assetReferences(s, id).length === 0 && a.type !== "font") delete s.assets[id];
    else warnings.push(`Asset '${id}' (${a.path}) stays in the template; it only resolves in a workspace that has that file.`);
  }
  const variables: string[] = [];
  for (const n of s.nodes) {
    if (n.kind !== "text2d") continue;
    const used = referencedVariables(n.content);
    if (used.length || opts.textVariables === false) {
      variables.push(...used);
      continue;
    }
    const v = n.id.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^([0-9])/, "_$1");
    s.variables[v] = n.content;
    n.content = `{{${v}}}`;
    variables.push(v);
  }
  const { id: _id, ...rest } = s;
  const template: TemplateFile = {
    name: opts.name,
    title: opts.title ?? scene.name ?? opts.name,
    description: opts.description ?? scene.description ?? `Saved from scene '${scene.id}'.`,
    screens: slots,
    variables: [...new Set(variables)],
    scene: rest as Record<string, unknown>,
  };
  return { template, warnings };
}

/** Fields compose_scene can override on a scene template; everything else is refined afterwards. */
const SCENE_OVERRIDES = new Set(["name", "concept", "preset", "canvas", "duration", "render", "style", "variables", "locales"]);

/**
 * Builds a scene from a scene template: fills each {{screenN}} slot with a screenshot (repeating them
 * in order if there are fewer), keeps every other setting of the saved screen (fit, focus, glare, ...).
 */
export async function instantiateSceneTemplate(
  ws: Workspace,
  devices: DeviceRegistry,
  tpl: TemplateFile,
  screens: string[],
  id: string,
  overrides: Record<string, unknown> = {},
): Promise<Scene> {
  if (!tpl.scene) throw new DwError("WRONG_TEMPLATE_KIND", `Template '${tpl.name}' is a ${templateKind(tpl)} template, not a scene.`);
  const unsupported = Object.keys(overrides).filter((k) => overrides[k] !== undefined && !SCENE_OVERRIDES.has(k));
  if (unsupported.length) {
    throw new DwError("TEMPLATE_OVERRIDE_UNSUPPORTED", `Scene template '${tpl.name}' can't take ${unsupported.join(", ")}: its devices, layout, text, camera and motion are saved as they are.`, {
      hint: "Compose it first, then refine with update_node / apply_motion / set_camera. Allowed here: " + [...SCENE_OVERRIDES].join(", ") + ".",
    });
  }
  const raw = structuredClone(tpl.scene) as Record<string, any>;
  const slots: Array<{ node: string; slot: number; source: Record<string, unknown> }> = [];
  for (const n of (raw.nodes ?? []) as Array<Record<string, any>>) {
    const m = n.kind === "device" && typeof n.screen?.source?.asset === "string" ? SLOT_RE.exec(n.screen.source.asset) : null;
    if (!m) continue;
    slots.push({ node: n.id, slot: Number(m[1]), source: n.screen.source });
    n.screen.source = { type: "color", color: "#000000" };
  }
  raw.id = id;
  if (typeof overrides.name === "string") raw.name = overrides.name;
  else raw.name ??= tpl.title;
  if (typeof overrides.concept === "string") raw.description = overrides.concept;
  let s = parseScene(migrateScene(raw));
  for (const { node, slot, source } of slots) {
    if (screens.length === 0) continue;
    const ref = screens[(slot - 1) % screens.length]!;
    const r = await ensureAsset(ws, s, ref);
    s = r.scene;
    const a = s.assets[r.assetId]!;
    if (a.type !== "image" && a.type !== "video") throw new DwError("ASSET_TYPE_MISMATCH", `Screen for slot ${slot} ('${ref}') is a ${a.type}, not an image or video.`);
    const keep = source.type === a.type ? source : {};
    s = updateNode(s, node, { screen: { source: { ...keep, type: a.type, asset: r.assetId, color: null } } }, devices);
  }
  const canvas: Record<string, number> = { ...((overrides.canvas as Record<string, number>) ?? {}) };
  if (typeof overrides.preset === "string") {
    const size = CANVAS_PRESETS[overrides.preset as CanvasPresetName];
    if (!size) throw new DwError("UNKNOWN_PRESET", `Unknown canvas preset '${overrides.preset}'.`);
    canvas.width ??= size[0];
    canvas.height ??= size[1];
  }
  if (typeof overrides.duration === "number") canvas.duration = overrides.duration;
  if (Object.keys(canvas).length) s = updateScene(s, { canvas });
  if (overrides.render) s = updateScene(s, { render: overrides.render as Record<string, unknown> });
  if (typeof overrides.style === "string") s = applyStyle(s, { style: overrides.style }, devices);
  if (overrides.variables) s = setVariables(s, { variables: overrides.variables as Record<string, string> });
  for (const [loc, vars] of Object.entries((overrides.locales as Record<string, Record<string, string>>) ?? {})) s = setVariables(s, { locale: loc, variables: vars });
  return s;
}

/* ----------------------------------------------------------------- motion */

export interface MotionClipOptions {
  /** [t0, t1] seconds; default the whole timeline. */
  range?: [number, number];
  /** The device the movement is about; default the scene's only device. */
  target?: string;
  /** Include camera tracks (and the static camera when it isn't animated). Default true. */
  includeCamera?: boolean;
  /** Include text tracks (applied to the target scene's text nodes in order). Default true. */
  includeText?: boolean;
}

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

/**
 * Cuts one movement out of a scene: the camera, the target device and the text tracks that change
 * over a time window. Camera points are stored in the device's frame, in units of its screen height, and device
 * position / rotation as offsets from its base pose, so the clip fits any device placement and size.
 */
export function sceneToMotionClip(scene: Scene, devices: DeviceRegistry, opts: MotionClipOptions = {}): { clip: MotionClip; warnings: string[] } {
  const D = scene.canvas.duration;
  const [t0, t1] = opts.range ?? [0, D];
  if (!(t0 >= 0 && t1 > t0)) throw new DwError("INVALID_RANGE", `range must be [start, end] with 0 <= start < end (got [${t0}, ${t1}]).`, { path: "range" });
  if (t1 > D + 1e-9) throw new DwError("INVALID_RANGE", `range ends at ${t1} s, after the timeline (${D} s).`, { path: "range" });
  const id = resolveDevice(scene, opts.target, "A motion clip");
  const node = scene.nodes.find((n) => n.id === id)!;
  if (node.kind !== "device") throw new DwError("INVALID_MOTION_TARGET", `'${id}' is not a device.`);
  const unit = devices.require(node.model).screen.height;
  const base = worldPose(scene, id);
  const texts = scene.nodes.filter((n) => n.kind === "text2d").map((n) => n.id);
  const tracks: MotionClip["tracks"] = [];
  const skipped = new Set<string>();
  const toDeviceUnits = (w: Vec3): Vec3 => vr6(v3.scale(toLocal(base, w), 1 / unit));
  for (const tr of scene.animation.tracks) {
    const ref = findTarget(scene, tr.target);
    const spec = ref ? animatableProperties(ref)[tr.property] : undefined;
    if (!ref || !spec) continue;
    const isCameraPath = tr.target === "camera" && (tr.property === "position" || tr.property === "target");
    const kfs = (): Keyframe[] => sliceTrack(tr, spec.kind, t0, t1, isCameraPath);
    if (tr.target === "camera") {
      if (opts.includeCamera === false) continue;
      tracks.push({ role: "camera", property: tr.property, relative: isCameraPath, interpolation: tr.interpolation, keyframes: isCameraPath ? kfs().map((k) => ({ ...k, value: toDeviceUnits(k.value as Vec3) })) : kfs() });
    } else if (tr.target === id) {
      const rel = tr.property === "position" || tr.property === "rotation";
      const baseV = tr.property === "position" ? node.transform.position : node.transform.rotation;
      const map = (v: Vec3): Vec3 => (tr.property === "position" ? vr6(v3.scale(v3.sub(v, baseV), 1 / unit)) : vr6(v3.sub(v, baseV)));
      tracks.push({ role: "device", property: tr.property, relative: rel, interpolation: tr.interpolation, keyframes: rel ? kfs().map((k) => ({ ...k, value: map(k.value as Vec3) })) : kfs() });
    } else if (texts.includes(tr.target)) {
      if (opts.includeText === false) continue;
      // Only text that changes in the window is part of the movement; a constant (e.g. a headline held
      // hidden) would otherwise stick on the target scene after the clip ends.
      const k = kfs();
      if (k.every((x) => JSON.stringify(x.value) === JSON.stringify(k[0]!.value))) continue;
      tracks.push({ role: `text${texts.indexOf(tr.target) + 1}`, property: tr.property, relative: false, interpolation: tr.interpolation, keyframes: k });
    } else skipped.add(tr.target);
  }
  if (opts.includeCamera !== false) {
    // The clip carries its framing: a camera property that isn't animated is saved as a constant.
    const c = scene.camera;
    const constant = (property: string, value: number | Vec3, relative: boolean) => {
      if (tracks.some((t) => t.role === "camera" && t.property === property)) return;
      tracks.push({ role: "camera", property, relative, interpolation: "linear", keyframes: [{ t: 0, value, easing: "linear" }, { t: r6(t1 - t0), value, easing: "linear" }] });
    };
    constant("position", toDeviceUnits(c.position), true);
    constant("target", toDeviceUnits(c.target), true);
    constant("fov", r6(c.fov), false);
  }
  if (tracks.length === 0) throw new DwError("NOTHING_TO_SAVE", `Nothing moves in [${t0}, ${t1}] s for '${id}'.`);
  const warnings = [...skipped].map((t) => `Tracks of '${t}' are not part of the clip (only the camera, '${id}' and text are).`);
  return { clip: { duration: r6(t1 - t0), unit, tracks }, warnings };
}

/** Plays a motion clip on a device of another (or the same) scene, starting at `start`. */
export function applyMotionClip(scene: Scene, clip: MotionClip, devices: DeviceRegistry, opts: { target?: string; start?: number } = {}): MotionResult & { skipped: string[] } {
  const start = opts.start ?? 0;
  const end = start + clip.duration;
  const id = resolveDevice(scene, opts.target, "A motion clip");
  const node = scene.nodes.find((n) => n.id === id)!;
  if (node.kind !== "device") throw new DwError("INVALID_MOTION_TARGET", `'${id}' is not a device.`);
  const unit = devices.require(node.model).screen.height;
  const base = worldPose(scene, id);
  const texts = scene.nodes.filter((n) => n.kind === "text2d").map((n) => n.id);
  let s = scene;
  const animated: MotionResult["animated"] = [];
  const skipped: string[] = [];
  for (const tr of clip.tracks) {
    let target: string;
    let map = (v: unknown): unknown => v;
    if (tr.role === "camera") {
      target = "camera";
      if (tr.relative) map = (v) => vr6(toWorld(base, v3.scale(v as Vec3, unit)));
    } else if (tr.role === "device") {
      target = id;
      if (tr.relative && tr.property === "position") map = (v) => vr6(v3.add(node.transform.position, v3.scale(v as Vec3, unit)));
      if (tr.relative && tr.property === "rotation") map = (v) => vr6(v3.add(node.transform.rotation, v as Vec3));
    } else {
      const textId = texts[Number(tr.role.slice(4)) - 1];
      if (!textId) {
        skipped.push(`${tr.role}.${tr.property}`);
        continue;
      }
      target = textId;
    }
    const keyframes = tr.keyframes.map((k) => ({ t: r6(start + k.t), value: map(k.value), ...(k.easing !== undefined ? { easing: k.easing } : {}) }));
    s = spliceTrack(s, target, tr.property, keyframes as never, [start, end], tr.interpolation as Track["interpolation"]);
    animated.push({ target, property: tr.property, from: start, to: end });
  }
  const result: MotionResult & { skipped: string[] } = { scene: s, animated, wrapped: [], skipped };
  if (end > s.canvas.duration + 1e-9) {
    const d = Math.ceil(end * 100) / 100;
    result.scene = updateScene(s, { canvas: { duration: d } });
    result.durationExtended = d;
  }
  return result;
}
