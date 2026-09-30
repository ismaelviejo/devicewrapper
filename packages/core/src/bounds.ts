import type { DeviceDefinition, Node, Scene, Vec3 } from "@devicewrapper/schema";
import type { DeviceRegistry } from "./devices.js";
import { DwError } from "./errors.js";
import { DEG, MAT4_IDENTITY, type Mat4, eulerDegToQuat, mat4Compose, mat4Multiply, mat4TransformPoint, v3 } from "./math.js";

export interface Box3 {
  min: Vec3;
  max: Vec3;
}

/** Local-space half extents of a device body, including the camera bump. */
function deviceLocalBox(def: DeviceDefinition): Box3 {
  const { width, height, depth } = def.body;
  const bump = def.cameraBump?.depth ?? 0;
  return { min: [-width / 2, -height / 2, -depth / 2 - bump], max: [width / 2, height / 2, depth / 2] };
}

function localBox(node: Node, devices: DeviceRegistry): Box3 | null {
  switch (node.kind) {
    case "device": {
      const def = devices.get(node.model);
      return def ? deviceLocalBox(def) : null;
    }
    case "plane":
      return { min: [-node.size[0] / 2, 0, -node.size[1] / 2], max: [node.size[0] / 2, 0, node.size[1] / 2] };
    case "primitive": {
      const [a, b, c] = node.size;
      switch (node.shape) {
        case "box":
          return { min: [-a / 2, -b / 2, -c / 2], max: [a / 2, b / 2, c / 2] };
        case "sphere":
          return { min: [-a / 2, -a / 2, -a / 2], max: [a / 2, a / 2, a / 2] };
        case "torus": {
          const r = a / 2;
          return { min: [-r, -r, -b / 2], max: [r, r, b / 2] };
        }
        default:
          return { min: [-a / 2, -b / 2, -a / 2], max: [a / 2, b / 2, a / 2] };
      }
    }
    default:
      return null;
  }
}

/** World matrix of a node (walks the parent chain). */
export function worldMatrix(scene: Scene, id: string, seen = new Set<string>()): Mat4 {
  const node = scene.nodes.find((n) => n.id === id);
  if (!node || node.kind === "text2d") return MAT4_IDENTITY;
  if (seen.has(id)) throw new DwError("PARENT_CYCLE", `Node '${id}' is part of a parent cycle.`);
  seen.add(id);
  const s = node.transform.scale;
  const local = mat4Compose(node.transform.position, eulerDegToQuat(node.transform.rotation), typeof s === "number" ? [s, s, s] : s);
  return node.parent ? mat4Multiply(worldMatrix(scene, node.parent, seen), local) : local;
}

function corners(b: Box3): Vec3[] {
  const out: Vec3[] = [];
  for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) out.push([x, y, z]);
  return out;
}

/** World-space corner points of the given nodes (groups include their descendants). */
export function worldPoints(scene: Scene, ids: string[], devices: DeviceRegistry): Vec3[] {
  const pts: Vec3[] = [];
  const visit = (id: string) => {
    const node = scene.nodes.find((n) => n.id === id);
    if (!node || node.kind === "text2d") return;
    const box = localBox(node, devices);
    if (box) {
      const m = worldMatrix(scene, id);
      for (const c of corners(box)) pts.push(mat4TransformPoint(m, c));
    }
    for (const child of scene.nodes) if (child.kind !== "text2d" && child.parent === id) visit(child.id);
  };
  for (const id of ids) visit(id);
  return pts;
}

export function boundsOf(points: Vec3[]): Box3 | null {
  if (points.length === 0) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i]!, p[i]!);
      max[i] = Math.max(max[i]!, p[i]!);
    }
  }
  return { min, max };
}

/* ------------------------------------------------------------ framing */

export interface FrameTargetsOptions {
  targets: string[];
  direction?: Vec3;
  padding?: number;
  fov: number;
  aspect: number;
  type: "perspective" | "orthographic";
  roll?: number;
}

export interface FrameResult {
  position: Vec3;
  target: Vec3;
  orthoHeight: number;
}

function lookBasis(dirToCamera: Vec3, roll: number): { right: Vec3; up: Vec3; forward: Vec3 } {
  const forward = v3.norm(v3.scale(dirToCamera, -1)); // camera looks along -dirToCamera
  let worldUp: Vec3 = [0, 1, 0];
  if (Math.abs(v3.dot(forward, worldUp)) > 0.999) worldUp = [0, 0, -1];
  let right = v3.norm(v3.cross(forward, worldUp));
  let up = v3.cross(right, forward);
  if (roll) {
    const r = roll * DEG, c = Math.cos(r), s = Math.sin(r);
    const r2: Vec3 = v3.add(v3.scale(right, c), v3.scale(up, s));
    const u2: Vec3 = v3.add(v3.scale(up, c), v3.scale(right, -s));
    right = r2;
    up = u2;
  }
  return { right, up, forward };
}

/**
 * Places the camera so every corner of the targets is inside the frame, with padding
 * as a fraction of the frame (0.15 = 15% margin; negative crops in). Deterministic.
 */
export function frameTargets(scene: Scene, devices: DeviceRegistry, opts: FrameTargetsOptions): FrameResult {
  const pts = worldPoints(scene, opts.targets, devices);
  const box = boundsOf(pts);
  if (!box) {
    throw new DwError("NOTHING_TO_FRAME", `None of [${opts.targets.join(", ")}] have visible geometry to frame.`, {
      hint: "Pass IDs of device, plane, primitive or group nodes.",
    });
  }
  const center = v3.scale(v3.add(box.min, box.max), 0.5);
  const dir = v3.norm(opts.direction ?? [0, 0, 1]);
  const { right, up, forward } = lookBasis(dir, opts.roll ?? 0);
  const pad = 1 + (opts.padding ?? 0.15);

  // Extents of the points in camera space (relative to center).
  let maxX = 0, maxY = 0, maxDepth = 0;
  for (const p of pts) {
    const d = v3.sub(p, center);
    maxX = Math.max(maxX, Math.abs(v3.dot(d, right)));
    maxY = Math.max(maxY, Math.abs(v3.dot(d, up)));
    maxDepth = Math.max(maxDepth, Math.abs(v3.dot(d, forward)));
  }

  if (opts.type === "orthographic") {
    const h = Math.max(maxY * 2, (maxX * 2) / opts.aspect) * pad;
    const dist = Math.max(1, maxDepth * 4);
    return { position: v3.add(center, v3.scale(dir, dist)), target: center, orthoHeight: Math.max(h, 1e-4) };
  }

  const tanV = Math.tan((opts.fov * DEG) / 2);
  const tanH = tanV * opts.aspect;
  const fits = (dist: number) => {
    const cam = v3.add(center, v3.scale(dir, dist));
    for (const p of pts) {
      const d = v3.sub(p, cam);
      const z = v3.dot(d, forward);
      if (z <= 1e-4) return false;
      if (Math.abs(v3.dot(d, right)) * pad > z * tanH) return false;
      if (Math.abs(v3.dot(d, up)) * pad > z * tanV) return false;
    }
    return true;
  };
  let lo = 1e-3, hi = 1e4;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  return { position: v3.add(center, v3.scale(dir, hi)), target: center, orthoHeight: scene.camera.orthoHeight };
}

/** Focal length (mm, 35mm full-frame equivalent) to vertical FOV in degrees. */
export function focalLengthToFov(mm: number): number {
  return (2 * Math.atan(12 / mm)) / DEG;
}
