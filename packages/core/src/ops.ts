import {
  Background,
  Camera,
  Canvas,
  Effect,
  Environment,
  Light,
  Material,
  Node,
  RenderSettings,
  Scene,
  Track,
  type Asset,
  type DeviceCategory,
  type Keyframe,
  type SceneInput,
  type Vec3,
} from "@devicewrapper/schema";
import { z } from "zod";
import { frameTargets } from "./bounds.js";
import { v3 } from "./math.js";
import { resolveDeviceColor, type DeviceRegistry } from "./devices.js";
import { DwError, schemaError } from "./errors.js";
import { allocateId } from "./ids.js";
import { CAMERA_SHOTS, SHOT_PRESETS, lightingPreset, type CameraShot, type LightingPresetName, LIGHTING_PRESET_NAMES } from "./presets.js";
import { animatableProperties, checkValue, findTarget } from "./properties.js";

/**
 * Scene operations. Every function is pure: (scene, args) -> new scene.
 * Inputs are validated; failures throw DwError with a path and a hint.
 */

export type Patch = Record<string, unknown>;

/* ------------------------------------------------------------ helpers */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** RFC 7396 JSON Merge Patch: objects merge recursively, arrays/primitives replace, null deletes. */
export function mergePatch<T>(target: T, patch: unknown): T {
  if (!isPlainObject(patch)) return patch as T;
  const base: Record<string, unknown> = isPlainObject(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete base[k];
    else if (v === undefined) continue;
    else base[k] = mergePatch(base[k], v);
  }
  return base as T;
}

function parseWith<S extends z.ZodType>(schema: S, value: unknown, prefix: string, what: string): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw schemaError(r.error.issues, prefix, what);
  return r.data;
}

export function parseScene(input: unknown): Scene {
  return parseWith(Scene, input, "", "Scene");
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

function takenIds(scene: Scene): Set<string> {
  return new Set<string>(["camera", ...scene.nodes.map((n) => n.id), ...scene.lights.map((l) => l.id)]);
}

function nodeIndex(scene: Scene, id: string): number {
  const i = scene.nodes.findIndex((n) => n.id === id);
  if (i < 0) {
    const ids = scene.nodes.map((n) => n.id);
    throw new DwError("UNKNOWN_NODE", `No node with ID '${id}' in scene '${scene.id}'. Existing nodes: ${ids.length ? ids.join(", ") : "(none)"}.`, {
      hint: "Call list_nodes to see IDs.",
    });
  }
  return i;
}

const CATEGORY_ID: Record<DeviceCategory, string> = {
  smartphone: "phone",
  tablet: "tablet",
  laptop: "laptop",
  monitor: "monitor",
  watch: "watch",
};

function checkParent(scene: Scene, nodeId: string, parent: string | undefined): void {
  if (parent === undefined) return;
  if (parent === nodeId) throw new DwError("PARENT_CYCLE", `Node '${nodeId}' cannot be its own parent.`, { path: "parent" });
  let cur: string | undefined = parent;
  const seen = new Set<string>([nodeId]);
  while (cur !== undefined) {
    const p = scene.nodes.find((n) => n.id === cur);
    if (!p) throw new DwError("UNKNOWN_PARENT", `Parent '${cur}' does not exist.`, { path: "parent", hint: "Create the group first with add_node (kind: 'group')." });
    if (p.kind === "text2d") throw new DwError("INVALID_PARENT", `'${cur}' is a text2d node and cannot have children.`, { path: "parent" });
    if (seen.has(cur)) throw new DwError("PARENT_CYCLE", `Setting parent '${parent}' on '${nodeId}' would create a cycle.`, { path: "parent" });
    seen.add(cur);
    cur = p.parent;
  }
}

function checkDevice(node: Node, devices: DeviceRegistry, prefix: string): void {
  if (node.kind !== "device") return;
  const def = devices.get(node.model);
  if (!def) {
    throw new DwError("UNKNOWN_DEVICE_MODEL", `Unknown device model '${node.model}'. Available: ${devices.ids().join(", ")}.`, {
      path: `${prefix}model`,
      hint: "Read the devicewrapper://devices resource for models and their colors.",
    });
  }
  if (!resolveDeviceColor(def, node.color)) {
    throw new DwError(
      "UNKNOWN_DEVICE_COLOR",
      `Model '${def.id}' has no color '${node.color}'. Use one of: ${def.colors.map((c) => c.name).join(", ")}, or a hex color like #336699.`,
      { path: `${prefix}color` },
    );
  }
}

/* ------------------------------------------------------------- scene */

export interface CreateSceneOptions {
  id: string;
  name?: string;
  description?: string;
  canvas?: Partial<z.input<typeof Canvas>>;
  background?: z.input<typeof Background>;
  lighting?: LightingPresetName | "none";
}

export function createScene(opts: CreateSceneOptions): Scene {
  const input: SceneInput = { id: opts.id };
  if (opts.name !== undefined) input.name = opts.name;
  if (opts.description !== undefined) input.description = opts.description;
  if (opts.canvas) input.canvas = parseWith(Canvas, opts.canvas, "canvas", "canvas");
  if (opts.background) input.background = opts.background;
  const scene = parseScene(input);
  const lighting = opts.lighting ?? "studio";
  if (lighting !== "none") {
    const p = lightingPreset(lighting);
    scene.lights = p.lights;
    scene.environment = p.environment;
  }
  return scene;
}

export interface UpdateScenePatch {
  name?: string | null;
  description?: string | null;
  seed?: number;
  canvas?: Patch;
  environment?: Patch;
  render?: Patch;
  defaultLocale?: string;
  materials?: Record<string, unknown>;
}

export function updateScene(scene: Scene, patch: UpdateScenePatch): Scene {
  const s = clone(scene);
  if (patch.name === null) delete s.name;
  else if (patch.name !== undefined) s.name = patch.name;
  if (patch.description === null) delete s.description;
  else if (patch.description !== undefined) s.description = patch.description;
  if (patch.seed !== undefined) s.seed = parseWith(z.number().int().min(0).max(2 ** 31 - 1), patch.seed, "seed", "seed");
  if (patch.canvas) s.canvas = parseWith(Canvas, mergePatch(s.canvas, patch.canvas), "canvas", "canvas");
  if (patch.environment) s.environment = parseWith(Environment, mergePatch(s.environment, patch.environment), "environment", "environment");
  if (patch.render) s.render = parseWith(RenderSettings, mergePatch(s.render, patch.render), "render", "render settings");
  if (patch.defaultLocale !== undefined) s.defaultLocale = patch.defaultLocale;
  if (patch.materials) {
    for (const [id, m] of Object.entries(patch.materials)) {
      if (m === null) {
        delete s.materials[id];
        continue;
      }
      s.materials[id] = parseWith(Material, mergePatch(s.materials[id], m), `materials.${id}`, `material '${id}'`);
    }
  }
  return s;
}

/* ------------------------------------------------------------- nodes */

export interface AddNodeResult {
  scene: Scene;
  id: string;
}

export function addNode(scene: Scene, input: Record<string, unknown>, devices: DeviceRegistry): AddNodeResult {
  const s = clone(scene);
  const taken = takenIds(s);
  const draft: Record<string, unknown> = { ...input };
  if (draft.id === undefined) {
    let base = String(draft.kind ?? "node");
    if (draft.kind === "device") {
      const def = devices.get(String(draft.model ?? ""));
      base = def ? CATEGORY_ID[def.category] : "device";
    } else if (typeof draft.name === "string") base = draft.name;
    else if (draft.kind === "primitive" && typeof draft.shape === "string") base = draft.shape;
    else if (draft.kind === "text2d") base = "text";
    draft.id = allocateId(base, taken);
  } else if (taken.has(String(draft.id))) {
    throw new DwError("DUPLICATE_ID", `ID '${String(draft.id)}' is already used in scene '${s.id}'.`, {
      path: "id",
      hint: "Omit id to get a free one automatically, or choose another.",
    });
  }
  const node = parseWith(Node, draft, "", "Node");
  checkDevice(node, devices, "");
  if (node.kind !== "text2d") checkParent(s, node.id, node.parent);
  s.nodes.push(node);
  return { scene: s, id: node.id };
}

export function updateNode(scene: Scene, id: string, patch: Patch, devices: DeviceRegistry): Scene {
  const s = clone(scene);
  const i = nodeIndex(s, id);
  const current = s.nodes[i]!;
  if (patch.id !== undefined && patch.id !== id) {
    throw new DwError("IMMUTABLE_FIELD", `Node IDs cannot be changed ('${id}' -> '${String(patch.id)}').`, {
      path: "id",
      hint: "Remove the node and add it again with the new ID.",
    });
  }
  if (patch.kind !== undefined && patch.kind !== current.kind) {
    throw new DwError("IMMUTABLE_FIELD", `Node '${id}' is a ${current.kind}; kind cannot change to ${String(patch.kind)}.`, {
      path: "kind",
      hint: "Remove the node and add a new one.",
    });
  }
  const merged = mergePatch(current as unknown as Record<string, unknown>, patch);
  const next = parseWith(Node, merged, "", `Node '${id}'`);
  checkDevice(next, devices, "");
  if (next.kind !== "text2d") checkParent(s, next.id, next.parent);
  s.nodes[i] = next;
  return s;
}

export interface RemoveNodeResult {
  scene: Scene;
  removed: string[];
  removedTracks: number;
}

export function removeNode(scene: Scene, id: string, opts: { recursive?: boolean } = {}): RemoveNodeResult {
  const s = clone(scene);
  const i = nodeIndex(s, id);
  const node = s.nodes[i]!;
  const removed = new Set<string>([id]);
  const parentOf = node.kind === "text2d" ? undefined : node.parent;
  if (opts.recursive) {
    let grew = true;
    while (grew) {
      grew = false;
      for (const n of s.nodes) {
        if (n.kind !== "text2d" && n.parent && removed.has(n.parent) && !removed.has(n.id)) {
          removed.add(n.id);
          grew = true;
        }
      }
    }
  } else {
    for (const n of s.nodes) {
      if (n.kind !== "text2d" && n.parent === id) {
        if (parentOf === undefined) delete n.parent;
        else n.parent = parentOf;
      }
    }
  }
  s.nodes = s.nodes.filter((n) => !removed.has(n.id));
  const before = s.animation.tracks.length;
  s.animation.tracks = s.animation.tracks.filter((t) => !removed.has(t.target));
  return { scene: s, removed: [...removed], removedTracks: before - s.animation.tracks.length };
}

/* ------------------------------------------------------------ camera */

export interface SetCameraOptions {
  patch?: Patch;
  focalLength?: number;
  frame?: { targets?: string[]; shot?: CameraShot; direction?: Vec3; padding?: number; shift?: [number, number] };
}

/** A top-level plane with a reflective material, if the scene has one (used to frame the reflection too). */
function reflectiveFloor(scene: Scene): { floorY: number; fade: number } | undefined {
  for (const n of scene.nodes) {
    if (n.kind !== "plane" || n.parent) continue;
    const m = typeof n.material === "string" ? scene.materials[n.material] : n.material;
    if (m?.type === "reflective" && m.strength > 0) return { floorY: n.transform.position[1], fade: m.fade };
  }
  return undefined;
}

export function setCamera(scene: Scene, opts: SetCameraOptions, devices: DeviceRegistry): Scene {
  const s = clone(scene);
  let cam = s.camera;
  if (opts.patch) cam = parseWith(Camera, mergePatch(cam, opts.patch), "camera", "camera");
  if (opts.focalLength !== undefined) {
    if (!(opts.focalLength > 0)) throw new DwError("INVALID_VALUE", "focalLength must be > 0 (millimeters, 35mm equivalent).", { path: "focalLength" });
    cam = { ...cam, fov: (2 * Math.atan(12 / opts.focalLength) * 180) / Math.PI };
  }
  if (opts.frame) {
    const shot = opts.frame.shot ?? "hero";
    if (!CAMERA_SHOTS.includes(shot)) {
      throw new DwError("UNKNOWN_SHOT", `Unknown shot '${shot}'. Use one of: ${CAMERA_SHOTS.join(", ")}.`, { path: "frame.shot" });
    }
    const preset = SHOT_PRESETS[shot]!;
    let targets = opts.frame.targets;
    if (!targets || targets.length === 0) {
      targets = s.nodes.filter((n) => n.kind === "device").map((n) => n.id);
      if (targets.length === 0) targets = s.nodes.filter((n) => n.kind === "primitive" || n.kind === "group").map((n) => n.id);
    }
    for (const t of targets) nodeIndex(s, t);
    const reflection = reflectiveFloor(s);
    const r = frameTargets({ ...s, camera: cam }, devices, {
      ...(reflection ? { reflection } : {}),
      targets,
      direction: opts.frame.direction ?? preset.direction,
      padding: opts.frame.padding ?? preset.padding,
      fov: cam.fov,
      aspect: s.canvas.width / s.canvas.height,
      type: cam.type,
      roll: cam.roll,
    });
    cam = { ...cam, position: r.position, target: r.target, orthoHeight: r.orthoHeight };
    const shift = opts.frame.shift;
    if (shift && (shift[0] || shift[1])) {
      // Move the subject within the frame: +y moves it down (room for a headline), +x moves it right.
      const fwd = v3.norm(v3.sub(cam.target, cam.position));
      let up: Vec3 = [0, 1, 0];
      if (Math.abs(v3.dot(fwd, up)) > 0.999) up = [0, 0, -1];
      const right = v3.norm(v3.cross(fwd, up));
      const camUp = v3.cross(right, fwd);
      const dist = v3.len(v3.sub(cam.target, cam.position));
      const visH = cam.type === "orthographic" ? cam.orthoHeight : 2 * dist * Math.tan((cam.fov * Math.PI) / 360);
      const visW = visH * (s.canvas.width / s.canvas.height);
      const move = v3.add(v3.scale(camUp, shift[1] * visH), v3.scale(right, -shift[0] * visW));
      cam = { ...cam, position: v3.add(cam.position, move), target: v3.add(cam.target, move) };
    }
  }
  if (cam.position.every((v, k) => Math.abs(v - cam.target[k]!) < 1e-9)) {
    throw new DwError("INVALID_CAMERA", "Camera position and target are the same point, so the view direction is undefined.", {
      path: "camera.position",
    });
  }
  if (cam.near >= cam.far) throw new DwError("INVALID_CAMERA", `camera.near (${cam.near}) must be less than camera.far (${cam.far}).`, { path: "camera.near" });
  s.camera = cam;
  return s;
}

/* ------------------------------------------------------------ lights */

export interface SetLightsOptions {
  preset?: LightingPresetName;
  keepEnvironment?: boolean;
  /** 'merge' upserts by id (default); 'replace' swaps the whole list. */
  mode?: "merge" | "replace";
  lights?: Array<Record<string, unknown>>;
  remove?: string[];
}

export function setLights(scene: Scene, opts: SetLightsOptions): Scene {
  const s = clone(scene);
  if (opts.preset) {
    if (!LIGHTING_PRESET_NAMES.includes(opts.preset)) {
      throw new DwError("UNKNOWN_PRESET", `Unknown lighting preset '${opts.preset}'. Use one of: ${LIGHTING_PRESET_NAMES.join(", ")}.`, { path: "preset" });
    }
    const p = lightingPreset(opts.preset);
    s.lights = p.lights;
    if (!opts.keepEnvironment) s.environment = p.environment;
  }
  const mode = opts.mode ?? "merge";
  if (opts.lights) {
    if (mode === "replace") s.lights = [];
    opts.lights.forEach((patch, idx) => {
      const id = patch.id;
      if (typeof id !== "string") throw new DwError("MISSING_ID", `lights[${idx}] needs an 'id'.`, { path: `lights[${idx}].id` });
      const existingIdx = s.lights.findIndex((l) => l.id === id);
      if (existingIdx >= 0) {
        const existing = s.lights[existingIdx]!;
        const base = patch.type !== undefined && patch.type !== existing.type ? { id } : existing;
        s.lights[existingIdx] = parseWith(Light, mergePatch(base, patch), `lights[${idx}]`, `light '${id}'`);
      } else {
        if (s.nodes.some((n) => n.id === id) || id === "camera") {
          throw new DwError("DUPLICATE_ID", `ID '${id}' is already used by a node. Lights and nodes share one ID namespace.`, { path: `lights[${idx}].id` });
        }
        if (patch.type === undefined) {
          throw new DwError("MISSING_TYPE", `New light '${id}' needs a 'type' (ambient, hemisphere, directional, point, spot).`, { path: `lights[${idx}].type` });
        }
        s.lights.push(parseWith(Light, patch, `lights[${idx}]`, `light '${id}'`));
      }
    });
  }
  if (opts.remove) {
    const rm = new Set(opts.remove);
    for (const id of rm) {
      if (!s.lights.some((l) => l.id === id)) throw new DwError("UNKNOWN_LIGHT", `No light '${id}'. Lights: ${s.lights.map((l) => l.id).join(", ") || "(none)"}.`);
    }
    s.lights = s.lights.filter((l) => !rm.has(l.id));
    s.animation.tracks = s.animation.tracks.filter((t) => !rm.has(t.target));
  }
  // Drop tracks whose light changed type such that the property no longer exists.
  s.animation.tracks = s.animation.tracks.filter((t) => {
    const ref = findTarget(s, t.target);
    return !ref || ref.type !== "light" || animatableProperties(ref)[t.property] !== undefined;
  });
  return s;
}

/* -------------------------------------------------------- background */

export function setBackground(scene: Scene, background: unknown): Scene {
  const s = clone(scene);
  s.background = parseWith(Background, background, "background", "background");
  return s;
}

/* ----------------------------------------------------------- effects */

export interface SetEffectsOptions {
  effects?: unknown[];
  upsert?: unknown[];
  remove?: string[];
}

export function setEffects(scene: Scene, opts: SetEffectsOptions): Scene {
  const s = clone(scene);
  if (opts.effects) s.effects = opts.effects.map((e, i) => parseWith(Effect, e, `effects[${i}]`, "effect"));
  if (opts.upsert) {
    opts.upsert.forEach((raw, i) => {
      const type = isPlainObject(raw) ? raw.type : undefined;
      const idx = s.effects.findIndex((e) => e.type === type);
      if (idx >= 0) s.effects[idx] = parseWith(Effect, mergePatch(s.effects[idx], raw), `upsert[${i}]`, "effect");
      else s.effects.push(parseWith(Effect, raw, `upsert[${i}]`, "effect"));
    });
  }
  if (opts.remove) {
    const rm = new Set(opts.remove);
    s.effects = s.effects.filter((e) => !rm.has(e.type));
  }
  return s;
}

/* --------------------------------------------------------- animation */

export interface SetTrackOptions {
  target: string;
  property: string;
  keyframes: Array<Record<string, unknown>>;
  interpolation?: "auto" | "linear" | "spline" | "slerp";
  /** 'replace' (default) swaps all keyframes; 'merge' upserts keyframes by time. */
  mode?: "replace" | "merge";
}

function describeTargets(scene: Scene): string {
  return ["camera", ...scene.nodes.map((n) => n.id), ...scene.lights.map((l) => l.id)].join(", ");
}

export function setTrack(scene: Scene, opts: SetTrackOptions): Scene {
  const s = clone(scene);
  const ref = findTarget(s, opts.target);
  if (!ref) {
    throw new DwError("UNKNOWN_TRACK_TARGET", `No node, light or camera named '${opts.target}'. Targets: ${describeTargets(s)}.`, { path: "target" });
  }
  const props = animatableProperties(ref);
  const spec = props[opts.property];
  if (!spec) {
    throw new DwError(
      "INVALID_TRACK_PROPERTY",
      `'${opts.property}' is not animatable on '${opts.target}'. Animatable: ${Object.keys(props).join(", ")}.`,
      { path: "property", hint: "Read devicewrapper://animatable for every target type." },
    );
  }
  if (opts.interpolation === "slerp" && spec.kind !== "rotation") {
    throw new DwError("INVALID_INTERPOLATION", "'slerp' only applies to rotation tracks.", { path: "interpolation" });
  }
  const incoming: Keyframe[] = opts.keyframes.map((k, i) => {
    const kf = parseWith(Track.shape.keyframes.element, k, `keyframes[${i}]`, "keyframe");
    const reason = checkValue(spec, kf.value);
    if (reason) {
      throw new DwError("INVALID_KEYFRAME_VALUE", `keyframes[${i}].value for '${opts.property}' ${reason} (got ${JSON.stringify(kf.value)}).`, {
        path: `keyframes[${i}].value`,
      });
    }
    return kf;
  });
  const existingIdx = s.animation.tracks.findIndex((t) => t.target === opts.target && t.property === opts.property);
  const existing = existingIdx >= 0 ? s.animation.tracks[existingIdx] : undefined;
  let keyframes: Keyframe[];
  if (opts.mode === "merge" && existing) {
    const byT = new Map<number, Keyframe>(existing.keyframes.map((k) => [k.t, k]));
    for (const k of incoming) byT.set(k.t, k);
    keyframes = [...byT.values()];
  } else {
    const seen = new Set<number>();
    for (const k of incoming) {
      if (seen.has(k.t)) throw new DwError("DUPLICATE_KEYFRAME_TIME", `Two keyframes at t=${k.t}s.`, { path: "keyframes" });
      seen.add(k.t);
    }
    keyframes = incoming;
  }
  if (keyframes.length === 0) throw new DwError("EMPTY_TRACK", "A track needs at least one keyframe.", { path: "keyframes" });
  keyframes.sort((a, b) => a.t - b.t);
  const track = parseWith(Track, {
    target: opts.target,
    property: opts.property,
    interpolation: opts.interpolation ?? existing?.interpolation ?? "auto",
    keyframes,
  }, "", "track");
  if (existingIdx >= 0) s.animation.tracks[existingIdx] = track;
  else s.animation.tracks.push(track);
  return s;
}

export function removeTrack(scene: Scene, target: string, property?: string): { scene: Scene; removed: number } {
  const s = clone(scene);
  const before = s.animation.tracks.length;
  s.animation.tracks = s.animation.tracks.filter((t) => !(t.target === target && (property === undefined || t.property === property)));
  const removed = before - s.animation.tracks.length;
  if (removed === 0) {
    throw new DwError("UNKNOWN_TRACK", `No track for target '${target}'${property ? ` property '${property}'` : ""}.`, {
      hint: "get_scene with detail 'full' lists animation tracks.",
    });
  }
  return { scene: s, removed };
}

/* ------------------------------------------------------ localization */

export interface SetVariablesOptions {
  variables?: Record<string, string | null>;
  locale?: string;
  defaultLocale?: string;
  removeLocale?: string;
}

const LOCALE_RE = /^[a-zA-Z]{2,3}([-_][a-zA-Z0-9]{2,8})*$/;

export function setVariables(scene: Scene, opts: SetVariablesOptions): Scene {
  const s = clone(scene);
  if (opts.locale !== undefined && !LOCALE_RE.test(opts.locale)) {
    throw new DwError("INVALID_LOCALE", `'${opts.locale}' is not a locale code. Use codes like en, es, fr, pt-BR, ja.`, { path: "locale" });
  }
  if (opts.variables) {
    const dict = opts.locale ? (s.locales[opts.locale] ??= {}) : s.variables;
    for (const [k, v] of Object.entries(opts.variables)) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)) {
        throw new DwError("INVALID_VARIABLE_NAME", `Variable name '${k}' must be letters, digits and '_' (e.g. appName).`, { path: `variables.${k}` });
      }
      if (v === null) delete dict[k];
      else dict[k] = String(v);
    }
  }
  if (opts.defaultLocale !== undefined) s.defaultLocale = opts.defaultLocale;
  if (opts.removeLocale !== undefined) delete s.locales[opts.removeLocale];
  return s;
}

/* ------------------------------------------------------------ assets */

export function assetReferences(scene: Scene, assetId: string): string[] {
  const refs: string[] = [];
  if ((scene.background.type === "image" || scene.background.type === "video") && scene.background.asset === assetId) refs.push("background");
  scene.nodes.forEach((n, i) => {
    if (n.kind === "device" && n.screen.source.type !== "color" && n.screen.source.asset === assetId) refs.push(`nodes[${i}] (${n.id}).screen`);
  });
  return refs;
}

export function setAsset(scene: Scene, id: string, asset: Asset): Scene {
  const s = clone(scene);
  s.assets[id] = asset;
  return s;
}

export function removeAsset(scene: Scene, id: string, force = false): Scene {
  const s = clone(scene);
  if (!s.assets[id]) throw new DwError("UNKNOWN_ASSET", `No asset '${id}' in scene '${s.id}'.`);
  const refs = assetReferences(s, id);
  if (refs.length && !force) {
    throw new DwError("ASSET_IN_USE", `Asset '${id}' is used by ${refs.join(", ")}.`, { hint: "Change those references first, or pass force: true." });
  }
  delete s.assets[id];
  return s;
}
