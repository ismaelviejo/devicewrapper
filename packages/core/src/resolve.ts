import type {
  Asset,
  Background,
  Canvas,
  DeviceDefinition,
  Effect,
  Environment,
  Material,
  MaterialRef,
  Node,
  Scene,
  Screen,
} from "@devicewrapper/schema";
import { hashValue } from "./canonical.js";
import { resolveDeviceColor, type DeviceRegistry } from "./devices.js";
import { DwError } from "./errors.js";

/* --------------------------------------------------------- variables */

const VAR_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

export function variablesFor(scene: Scene, locale?: string): Record<string, string> {
  const loc = locale ?? scene.defaultLocale;
  return { locale: loc, ...scene.variables, ...(scene.locales[loc] ?? {}) };
}

/** Replaces {{name}} placeholders. Unknown names are left visible so mistakes are obvious in renders. */
export function substitute(text: string, vars: Record<string, string>): string {
  return text.replace(VAR_RE, (m, name: string) => (Object.prototype.hasOwnProperty.call(vars, name) ? vars[name]! : m));
}

export function referencedVariables(text: string): string[] {
  return [...text.matchAll(VAR_RE)].map((m) => m[1]!);
}

/* ---------------------------------------------------------- resolved */

interface ResolvedBase {
  id: string;
  parent?: string;
  castShadow: boolean;
  receiveShadow: boolean;
}

export interface ResolvedDevice extends ResolvedBase {
  kind: "device";
  def: DeviceDefinition;
  bodyColor: string;
  finish: "metal" | "matte" | "glossy";
  bodyMaterial?: Material;
  screen: Screen;
}

export interface ResolvedPlane extends ResolvedBase {
  kind: "plane";
  size: [number, number];
  material: Material;
}

export interface ResolvedPrimitive extends ResolvedBase {
  kind: "primitive";
  shape: "box" | "sphere" | "cylinder" | "cone" | "torus" | "capsule";
  size: [number, number, number];
  cornerRadius: number;
  material: Material;
}

export interface ResolvedGroup extends ResolvedBase {
  kind: "group";
}

export interface ResolvedText {
  id: string;
  kind: "text2d";
  content: string;
  font: string;
  weight: number;
  align: "left" | "center" | "right";
  letterSpacing: number;
  lineHeight: number;
  maxWidth: number;
}

export type ResolvedNode = ResolvedDevice | ResolvedPlane | ResolvedPrimitive | ResolvedGroup | ResolvedText;

export interface ResolvedAsset extends Asset {
  id: string;
  absPath: string;
}

/**
 * Everything static about a scene, ready for a renderer: devices looked up, materials inlined,
 * variables substituted for one locale, asset paths absolute. Animated values come from FrameState.
 */
export interface ResolvedScene {
  sceneId: string;
  hash: string;
  locale: string;
  seed: number;
  canvas: Canvas;
  background: Background;
  environment: Environment;
  effects: Effect[];
  nodes: ResolvedNode[];
  assets: Record<string, ResolvedAsset>;
  scene: Scene;
}

export function resolveMaterial(scene: Scene, ref: MaterialRef, path: string): Material {
  if (typeof ref !== "string") return ref;
  const m = scene.materials[ref];
  if (!m) {
    throw new DwError("UNKNOWN_MATERIAL", `Material '${ref}' is not defined in scene.materials.`, {
      path,
      hint: `Defined materials: ${Object.keys(scene.materials).join(", ") || "(none)"}. Or use an inline material object.`,
    });
  }
  return m;
}

export interface ResolveOptions {
  devices: DeviceRegistry;
  locale?: string;
  /** Maps a stored asset path to an absolute, security-checked path. */
  resolveAssetPath: (path: string) => string;
}

export function resolveScene(scene: Scene, opts: ResolveOptions): ResolvedScene {
  const locale = opts.locale ?? scene.defaultLocale;
  const vars = variablesFor(scene, locale);
  const nodes: ResolvedNode[] = scene.nodes.map((n: Node, i): ResolvedNode => {
    const base = (): ResolvedBase => {
      if (n.kind === "text2d") throw new Error("unreachable");
      const b: ResolvedBase = { id: n.id, castShadow: n.castShadow, receiveShadow: n.receiveShadow };
      if (n.parent !== undefined) b.parent = n.parent;
      return b;
    };
    switch (n.kind) {
      case "device": {
        const def = opts.devices.require(n.model);
        const color = resolveDeviceColor(def, n.color);
        if (!color) throw new DwError("UNKNOWN_DEVICE_COLOR", `Model '${def.id}' has no color '${n.color}'.`, { path: `nodes[${i}].color` });
        const r: ResolvedDevice = { ...base(), kind: "device", def, bodyColor: color.body, finish: color.finish, screen: n.screen };
        if (n.material !== undefined) r.bodyMaterial = resolveMaterial(scene, n.material, `nodes[${i}].material`);
        return r;
      }
      case "plane":
        return { ...base(), kind: "plane", size: n.size, material: resolveMaterial(scene, n.material, `nodes[${i}].material`) };
      case "primitive":
        return {
          ...base(),
          kind: "primitive",
          shape: n.shape,
          size: n.size,
          cornerRadius: n.cornerRadius,
          material: resolveMaterial(scene, n.material, `nodes[${i}].material`),
        };
      case "group":
        return { ...base(), kind: "group" };
      case "text2d":
        return {
          id: n.id,
          kind: "text2d",
          content: substitute(n.content, vars),
          font: n.font,
          weight: n.weight,
          align: n.align,
          letterSpacing: n.letterSpacing,
          lineHeight: n.lineHeight,
          maxWidth: n.maxWidth,
        };
    }
  });
  const assets: Record<string, ResolvedAsset> = {};
  for (const [id, a] of Object.entries(scene.assets)) assets[id] = { ...a, id, absPath: opts.resolveAssetPath(a.path) };
  return {
    sceneId: scene.id,
    hash: hashValue({ scene, locale }),
    locale,
    seed: scene.seed,
    canvas: scene.canvas,
    background: scene.background,
    environment: scene.environment,
    effects: scene.effects,
    nodes,
    assets,
    scene,
  };
}
