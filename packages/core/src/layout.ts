import type { DeviceNode, Scene, Vec3 } from "@devicewrapper/schema";
import { deviceLocalBox, deviceSize, worldPoints, boundsOf } from "./bounds.js";
import type { DeviceRegistry } from "./devices.js";
import { DwError } from "./errors.js";
import { updateNode, addNode } from "./ops.js";

/**
 * Layouts arrange devices with real sizes: devices stand on a common floor line (y = 0 is the
 * composition's vertical center), spacing is relative to device widths, so a laptop and a phone
 * compose correctly together.
 */

export const LAYOUTS = {
  hero: "One device centered and turned slightly (angle, default 18°). With several devices, falls back to 'arc'.",
  row: "Side by side, facing forward, evenly spaced (spacing = gap as a fraction of device width, default 0.25).",
  arc: "Side by side on a gentle curve: outer devices pushed back and turned toward the center (angle default 16°).",
  fan: "Overlapping like a hand of cards, tilted around a pivot below them (angle default 12°).",
  stack: "Staggered diagonally in depth, all turned the same way (angle default 25°); the last device is in front.",
  grid: "Flat grid facing the camera (columns default √n).",
  circle: "On a ring facing outward, for turntable/carousel motion (rotate the ring with apply_motion on the group).",
  showcase: "Largest device in the center, smaller ones in front at its sides (e.g. laptop + phone, tablet + phones).",
} as const;
export type LayoutName = keyof typeof LAYOUTS;
export const LAYOUT_NAMES = Object.keys(LAYOUTS) as LayoutName[];

export interface LayoutOptions {
  layout: LayoutName;
  targets?: string[];
  spacing?: number;
  angle?: number;
  depth?: number;
  columns?: number;
  /** Extra X tilt (degrees) applied to every device, e.g. -8 to lean tops back. */
  tilt?: number;
}

interface Item {
  id: string;
  width: number;
  height: number;
  depth: number;
  /** Local bottom (min y) of the device box. */
  bottom: number;
}

/** Group that the circle layout puts devices in, so the whole ring can turn. */
export const CAROUSEL = "carousel";

const r3 = (v: number) => Math.round(v * 1e6) / 1e6;
const vec = (x: number, y: number, z: number): Vec3 => [r3(x), r3(y), r3(z)];

function items(scene: Scene, devices: DeviceRegistry, targets?: string[]): Item[] {
  const ids = targets && targets.length ? targets : scene.nodes.filter((n) => n.kind === "device" && (!n.parent || n.parent === CAROUSEL)).map((n) => n.id);
  if (ids.length === 0) throw new DwError("NOTHING_TO_LAYOUT", "There are no devices to arrange.", { hint: "Add devices with add_device first." });
  return ids.map((id) => {
    const n = scene.nodes.find((x) => x.id === id);
    if (!n) throw new DwError("UNKNOWN_NODE", `No node '${id}'.`);
    if (n.kind !== "device") throw new DwError("NOT_A_DEVICE", `'${id}' is a ${n.kind}; layouts arrange devices.`);
    const def = devices.require((n as DeviceNode).model);
    const [width, height, depth] = deviceSize(def, n.lidAngle);
    return { id, width, height, depth, bottom: deviceLocalBox(def, n.lidAngle).min[1] };
  });
}

function place(scene: Scene, devices: DeviceRegistry, id: string, position: Vec3, rotation: Vec3): Scene {
  return updateNode(scene, id, { transform: { position, rotation } }, devices);
}

/** Arranges devices; returns the new scene. Deterministic for the same input. */
export function applyLayout(scene: Scene, opts: LayoutOptions, devices: DeviceRegistry): Scene {
  let layout = opts.layout;
  if (!LAYOUT_NAMES.includes(layout)) {
    throw new DwError("UNKNOWN_LAYOUT", `Unknown layout '${layout}'. Use one of: ${LAYOUT_NAMES.join(", ")}.`);
  }
  const list = items(scene, devices, opts.targets);
  if (layout === "hero" && list.length > 1) layout = "arc";
  let s = scene;
  if (layout === "circle") {
    if (!s.nodes.some((n) => n.id === CAROUSEL)) s = addNode(s, { id: CAROUSEL, kind: "group" }, devices).scene;
    for (const i of list) s = updateNode(s, i.id, { parent: CAROUSEL }, devices);
  } else {
    for (const i of list) {
      const n = s.nodes.find((x) => x.id === i.id);
      if (n && n.kind === "device" && n.parent === CAROUSEL) s = updateNode(s, i.id, { parent: null }, devices);
    }
    if (s.nodes.some((n) => n.id === CAROUSEL) && !s.nodes.some((n) => n.kind !== "text2d" && n.parent === CAROUSEL)) {
      s = { ...s, nodes: s.nodes.filter((n) => n.id !== CAROUSEL), animation: { tracks: s.animation.tracks.filter((t) => t.target !== CAROUSEL) } };
    }
  }
  const n = list.length;
  const tilt = opts.tilt ?? 0;
  const maxH = Math.max(...list.map((i) => i.height));
  const avgW = list.reduce((a, i) => a + i.width, 0) / n;
  const floorY = -maxH / 2;
  const standY = (i: Item) => floorY - i.bottom;

  const rowXs = (gapFrac: number): number[] => {
    const gap = gapFrac * avgW;
    const total = list.reduce((a, i) => a + i.width, 0) + gap * (n - 1);
    let x = -total / 2;
    return list.map((i) => {
      const cx = x + i.width / 2;
      x += i.width + gap;
      return cx;
    });
  };

  switch (layout) {
    case "hero": {
      const i = list[0]!;
      s = place(s, devices, i.id, vec(0, standY(i), 0), [tilt, -(opts.angle ?? 18), 0]);
      break;
    }
    case "row": {
      const xs = rowXs(opts.spacing ?? 0.25);
      list.forEach((i, k) => (s = place(s, devices, i.id, vec(xs[k]!, standY(i), 0), [tilt, opts.angle ?? 0, 0])));
      break;
    }
    case "arc": {
      const xs = rowXs(opts.spacing ?? 0.18);
      const maxX = Math.max(...xs.map(Math.abs), 1e-9);
      const angle = opts.angle ?? 16;
      const depth = opts.depth ?? avgW * 0.35;
      list.forEach((i, k) => {
        const u = xs[k]! / maxX;
        s = place(s, devices, i.id, vec(xs[k]!, standY(i), -depth * u * u), [tilt, -angle * u, 0]);
      });
      break;
    }
    case "fan": {
      const angle = opts.angle ?? 12;
      const spread = avgW * (opts.spacing ?? 0.5);
      const mid = (n - 1) / 2;
      const pivotDrop = maxH * 0.9;
      list.forEach((i, k) => {
        const u = n > 1 ? (k - mid) / mid : 0;
        const a = angle * u * (Math.PI / 180);
        const x = u * spread + Math.sin(a) * -pivotDrop * 0.2;
        const y = standY(i) + (Math.cos(a) - 1) * pivotDrop;
        s = place(s, devices, i.id, vec(x, y, -Math.abs(k - mid) * 0.006), [tilt, 0, angle * -u]);
      });
      break;
    }
    case "stack": {
      const angle = opts.angle ?? 25;
      const stepX = avgW * (opts.spacing ?? 0.42);
      const stepZ = opts.depth ?? avgW * 0.45;
      const mid = (n - 1) / 2;
      list.forEach((i, k) => s = place(s, devices, i.id, vec((k - mid) * stepX, standY(i), (k - (n - 1)) * stepZ), [tilt, -angle, 0]));
      break;
    }
    case "grid": {
      const cols = Math.max(1, Math.min(n, opts.columns ?? Math.ceil(Math.sqrt(n))));
      const rows = Math.ceil(n / cols);
      const gap = (opts.spacing ?? 0.2) * avgW;
      const cellW = Math.max(...list.map((i) => i.width)) + gap;
      const cellH = maxH + gap;
      list.forEach((i, k) => {
        const c = k % cols, r = Math.floor(k / cols);
        const x = (c - (cols - 1) / 2) * cellW;
        const y = ((rows - 1) / 2 - r) * cellH;
        s = place(s, devices, i.id, vec(x, y, 0), [tilt, 0, 0]);
      });
      break;
    }
    case "circle": {
      const gap = (opts.spacing ?? 0.35) * avgW;
      const circumference = list.reduce((a, i) => a + i.width, 0) + gap * n;
      const radius = Math.max(avgW * 0.6, circumference / (2 * Math.PI));
      list.forEach((i, k) => {
        const theta = (k / n) * 2 * Math.PI;
        s = place(s, devices, i.id, vec(Math.sin(theta) * radius, standY(i), Math.cos(theta) * radius), [tilt, (theta * 180) / Math.PI, 0]);
      });
      break;
    }
    case "showcase": {
      const sorted = [...list].sort((a, b) => b.width * b.height - a.width * a.height);
      const main = sorted[0]!;
      const rest = sorted.slice(1);
      s = place(s, devices, main.id, vec(0, standY(main), 0), [tilt, 0, 0]);
      const angle = opts.angle ?? 14;
      rest.forEach((i, k) => {
        const side = k % 2 === 0 ? 1 : -1;
        const row = Math.floor(k / 2);
        const x = side * (main.width / 2 - i.width * 0.15 + row * i.width * 0.9);
        const z = main.depth / 2 + i.depth + 0.02 + row * 0.01;
        s = place(s, devices, i.id, vec(x, standY(i), z), [tilt, -side * angle, 0]);
      });
      break;
    }
  }
  return fitFloor(s, devices);
}

/** Moves the 'floor' plane (if any) to just under the lowest device. */
export function fitFloor(scene: Scene, devices: DeviceRegistry): Scene {
  const floor = scene.nodes.find((n) => n.id === "floor" && n.kind === "plane");
  if (!floor || floor.kind !== "plane") return scene;
  const deviceIds = scene.nodes.filter((n) => n.kind === "device").map((n) => n.id);
  const box = boundsOf(worldPoints(scene, deviceIds, devices));
  if (!box) return scene;
  const y = r3(box.min[1] - 0.0004);
  return updateNode(scene, "floor", { transform: { position: [0, y, r3((box.min[2] + box.max[2]) / 2)] } }, devices);
}

export type FloorSpec =
  | { type: "none" }
  | { type: "shadow"; opacity?: number }
  | { type: "solid"; color: string; roughness?: number; metalness?: number }
  | { type: "reflective"; strength?: number; blur?: number; fade?: number; shadowOpacity?: number };

/** Adds, updates or removes the 'floor' plane, then fits it under the devices. */
export function setFloor(scene: Scene, spec: FloorSpec, devices: DeviceRegistry): Scene {
  let s = scene;
  const existing = s.nodes.find((n) => n.id === "floor");
  if (spec.type === "none") {
    if (existing) s = { ...s, nodes: s.nodes.filter((n) => n.id !== "floor") };
    return s;
  }
  const material =
    spec.type === "shadow"
      ? { type: "shadowCatcher", opacity: spec.opacity ?? 0.3 }
      : spec.type === "reflective"
        ? { type: "reflective", strength: spec.strength ?? 0.3, blur: spec.blur ?? 0.25, fade: spec.fade ?? 0.5, shadowOpacity: spec.shadowOpacity ?? 0.25 }
        : { type: "pbr", color: spec.color, roughness: spec.roughness ?? 0.85, metalness: spec.metalness ?? 0 };
  if (existing) s = updateNode(s, "floor", { material, size: [20, 20] }, devices);
  else s = addNode(s, { id: "floor", kind: "plane", size: [20, 20], material, castShadow: false, receiveShadow: true }, devices).scene;
  return fitFloor(s, devices);
}
