import type { DeviceDefinition, Keyframe, KeyframeValue, Quat, Scene, Track, Vec3 } from "@devicewrapper/schema";
import { DwError } from "./errors.js";
import { eulerDegToQuat, quatConjugate, quatMultiply, quatRotate, v3 } from "./math.js";
import { setTrack } from "./ops.js";
import type { ValueKind } from "./properties.js";
import { evaluateFrame, evaluateTrack } from "./timeline.js";

/**
 * Poses and track windows: where a node is in the world at a given time, where a device's display
 * is, and how to cut a time window out of a track or splice one into it. Used by the screen-relative
 * camera motions (focus, reframe) and by motion clips.
 */

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
export const vr6 = (v: Vec3): Vec3 => [r6(v[0]), r6(v[1]), r6(v[2])];

/** World position, rotation and (uniform) scale of a 3D node. */
export interface Pose {
  p: Vec3;
  q: Quat;
  s: number;
}

const uniform = (s: number | Vec3): number => (typeof s === "number" ? s : (s[0] + s[1] + s[2]) / 3);

/** World pose of a 3D node: its static transform, or (with `t`) its animated pose at time t. */
export function worldPose(scene: Scene, id: string, t?: number): Pose {
  const frame = t === undefined ? null : evaluateFrame(scene, t);
  const walk = (nid: string, seen: Set<string>): Pose => {
    const node = scene.nodes.find((n) => n.id === nid);
    if (!node || node.kind === "text2d") throw new DwError("UNKNOWN_NODE", `No 3D node '${nid}'.`);
    if (seen.has(nid)) throw new DwError("PARENT_CYCLE", `Node '${nid}' is part of a parent cycle.`);
    seen.add(nid);
    const f = frame?.nodes[nid];
    const local: Pose = f
      ? { p: f.position, q: f.quaternion, s: uniform(f.scale) }
      : { p: node.transform.position, q: eulerDegToQuat(node.transform.rotation), s: uniform(node.transform.scale) };
    if (!node.parent) return local;
    const P = walk(node.parent, seen);
    return { p: v3.add(P.p, quatRotate(P.q, v3.scale(local.p, P.s))), q: quatMultiply(P.q, local.q), s: P.s * local.s };
  };
  return walk(id, new Set());
}

export const toWorld = (pose: Pose, local: Vec3): Vec3 => v3.add(pose.p, quatRotate(pose.q, v3.scale(local, pose.s)));
export const toLocal = (pose: Pose, world: Vec3): Vec3 => v3.scale(quatRotate(quatConjugate(pose.q), v3.sub(world, pose.p)), 1 / pose.s);

/** A device's display in its local space: center, in-plane axes, outward normal and visible size. */
export interface ScreenFrame {
  center: Vec3;
  right: Vec3;
  up: Vec3;
  normal: Vec3;
  width: number;
  height: number;
}

export function screenFrameLocal(def: DeviceDefinition, lidAngle?: number): ScreenFrame {
  const sc = def.screen;
  if (def.form === "laptop") {
    // Same hinge as the bounds and the renderer: at the back top edge of the base, lid tilted back by (angle - 90).
    const a = (((lidAngle ?? def.defaultLidAngle) - 90) * Math.PI) / 180;
    const up: Vec3 = [0, Math.cos(a), -Math.sin(a)];
    const normal: Vec3 = [0, Math.sin(a), Math.cos(a)];
    const hinge: Vec3 = [0, def.base.thickness / 2, -def.base.depth / 2];
    const center = v3.add(v3.add(hinge, v3.scale(up, def.lid.height / 2 + sc.offset[1])), [sc.offset[0], 0, 0]);
    return { center, right: [1, 0, 0], up, normal, width: sc.width, height: sc.height };
  }
  return { center: [sc.offset[0], sc.offset[1], def.body.depth / 2], right: [1, 0, 0], up: [0, 1, 0], normal: [0, 0, 1], width: sc.width, height: sc.height };
}

/** Local point on the display; [x, y] are 0..1 from the top-left corner of the visible display. */
export function screenPoint(sf: ScreenFrame, point: [number, number]): Vec3 {
  return v3.add(sf.center, v3.add(v3.scale(sf.right, (point[0] - 0.5) * sf.width), v3.scale(sf.up, (0.5 - point[1]) * sf.height)));
}

/** The scene with every node's transform (and laptop lid) set to its animated value at time t. */
export function posedScene(scene: Scene, t: number): Scene {
  const s = structuredClone(scene);
  for (const tr of scene.animation.tracks) {
    const node = s.nodes.find((n) => n.id === tr.target);
    if (!node || node.kind === "text2d") continue;
    if (tr.property === "position") node.transform.position = vr6(evaluateTrack(tr, "vec3", t) as Vec3);
    else if (tr.property === "rotation") node.transform.rotation = vr6(evaluateTrack({ ...tr, interpolation: "linear" }, "vec3", t) as Vec3);
    else if (tr.property === "scale") node.transform.scale = vr6(evaluateTrack(tr, "scale", t) as Vec3);
    else if (tr.property === "lidAngle" && node.kind === "device") node.lidAngle = r6(evaluateTrack(tr, "number", t) as number);
  }
  const cam = evaluateFrame(scene, t).camera;
  s.camera = { ...s.camera, fov: cam.fov, roll: cam.roll };
  return s;
}

/* -------------------------------------------------------------- windows */

/** Samples per second when an eased segment has to be cut and baked. */
const BAKE_RATE = 30;

function usesSpline(track: Track, kind: ValueKind, isCameraPath: boolean): boolean {
  return kind === "vec3" && (track.interpolation === "spline" || (track.interpolation === "auto" && isCameraPath && track.keyframes.length >= 3));
}

/** Value of a track at t, with rotations as Euler degrees (so they can be stored as keyframes again). */
export function trackValueAt(track: Track, kind: ValueKind, t: number, isCameraPath = false): KeyframeValue {
  if (kind === "rotation") return vr6(evaluateTrack({ ...track, interpolation: "linear" }, "vec3", t) as Vec3);
  const v = evaluateTrack(track, kind, t, isCameraPath) as KeyframeValue;
  if (typeof v === "number") return r6(v);
  if (Array.isArray(v)) return v.map((x) => r6(x as number)) as KeyframeValue;
  return v;
}

/**
 * Cuts [t0, t1] out of a track, re-timed to start at 0. Segments fully inside the window are copied
 * with their easing; a segment the window cuts through is copied as-is when linear (or step) and baked
 * into short linear steps otherwise, so the motion looks the same. Splines are baked whole.
 */
export function sliceTrack(track: Track, kind: ValueKind, t0: number, t1: number, isCameraPath = false): Keyframe[] {
  const kfs = [...track.keyframes].sort((a, b) => a.t - b.t);
  const at = (t: number) => trackValueAt(track, kind, t, isCameraPath);
  const shift = (t: number) => r6(t - t0);
  const bake = (a: number, b: number): Keyframe[] => {
    const n = Math.max(1, Math.ceil((b - a) * BAKE_RATE));
    return Array.from({ length: n }, (_, k) => ({ t: shift(a + ((b - a) * k) / n), value: at(a + ((b - a) * k) / n), easing: "linear" as const }));
  };
  if (kfs.length === 1 || (track.interpolation === "slerp" && kind === "rotation") || usesSpline(track, kind, isCameraPath)) {
    if (kfs.length === 1) return [{ t: 0, value: kfs[0]!.value, easing: "linear" }, { t: shift(t1), value: kfs[0]!.value, easing: "linear" }];
    return [...bake(t0, t1), { t: shift(t1), value: at(t1), easing: "linear" }];
  }
  const cuts = [t0, ...kfs.map((k) => k.t).filter((t) => t > t0 + 1e-9 && t < t1 - 1e-9), t1];
  const out: Keyframe[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const u = cuts[i]!, v = cuts[i + 1]!;
    const mid = (u + v) / 2;
    const segIdx = kfs.findIndex((k, j) => j < kfs.length - 1 && k.t <= mid && kfs[j + 1]!.t >= mid);
    if (segIdx < 0) {
      out.push({ t: shift(u), value: at(u), easing: "linear" }); // before the first or after the last keyframe: constant
      continue;
    }
    const a = kfs[segIdx]!, b = kfs[segIdx + 1]!;
    const easing = a.easing ?? "linear";
    const whole = Math.abs(u - a.t) < 1e-9 && Math.abs(v - b.t) < 1e-9;
    if (whole) out.push({ t: shift(u), value: a.value, easing: a.easing });
    else if (easing === "linear" || easing === "step") out.push({ t: shift(u), value: at(u), easing });
    else out.push(...bake(u, v));
  }
  out.push({ t: shift(t1), value: at(t1), easing: "linear" });
  const byT = new Map<number, Keyframe>();
  for (const k of out) if (!byT.has(k.t)) byT.set(k.t, k);
  return [...byT.values()];
}

/**
 * Replaces what a track does inside [w0, w1] with new keyframes (absolute times) and keeps everything
 * outside the window, so motions can be chained on one timeline.
 */
export function spliceTrack(scene: Scene, target: string, property: string, keyframes: Keyframe[], window: [number, number], interpolation?: Track["interpolation"]): Scene {
  const [w0, w1] = window;
  const existing = scene.animation.tracks.find((t) => t.target === target && t.property === property);
  const keep = existing ? existing.keyframes.filter((k) => k.t < w0 - 1e-6 || k.t > w1 + 1e-6) : [];
  const byT = new Map<number, Keyframe>(keep.map((k) => [k.t, k]));
  for (const k of keyframes) byT.set(k.t, k);
  return setTrack(scene, {
    target,
    property,
    keyframes: [...byT.values()] as never,
    ...(interpolation ? { interpolation } : {}),
  });
}
