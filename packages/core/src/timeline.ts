import type { Keyframe, KeyframeValue, Light, Quat, Scene, Track, Vec2, Vec3 } from "@devicewrapper/schema";
import { catmullRom, easingFn, eulerDegToQuat, lerp, lerpColor, round, slerp, v3 } from "./math.js";
import { animatableProperties, findTarget, type ValueKind } from "./properties.js";

/**
 * FrameState: every animatable value at one instant, as plain data.
 * Renderers draw a FrameState; they never interpret the timeline themselves.
 */
export interface NodeFrame {
  position: Vec3;
  quaternion: Quat;
  scale: Vec3;
  visible: boolean;
  opacity: number;
  screenBrightness?: number;
  screenGlare?: number;
  /** Laptops: lid angle in degrees; undefined = the model's default. */
  lidAngle?: number;
  /** text2d only */
  anchor?: Vec2;
  rotation?: number;
  size?: number;
  color?: string;
}

export interface CameraFrame {
  position: Vec3;
  target: Vec3;
  roll: number;
  fov: number;
  orthoHeight: number;
  dofFocusDistance: number;
  dofAperture: number;
}

export interface LightFrame {
  intensity: number;
  color: string;
  groundColor?: string;
  position?: Vec3;
  target?: Vec3;
  angle?: number;
  penumbra?: number;
}

export interface FrameState {
  time: number;
  camera: CameraFrame;
  lights: Record<string, LightFrame>;
  nodes: Record<string, NodeFrame>;
}

/* --------------------------------------------------------------- tracks */

function sortedKeyframes(track: Track): Keyframe[] {
  return [...track.keyframes].sort((a, b) => a.t - b.t);
}

function asScale(v: KeyframeValue): Vec3 {
  return typeof v === "number" ? [v, v, v] : (v as Vec3);
}

/**
 * Evaluates one track at time t. Rotation tracks return a quaternion.
 * Before the first keyframe the first value holds; after the last the last value holds.
 */
export function evaluateTrack(track: Track, kind: ValueKind, t: number, isCameraPath = false): KeyframeValue | Quat {
  const kfs = sortedKeyframes(track);
  const first = kfs[0]!;
  const last = kfs[kfs.length - 1]!;
  const finish = (v: KeyframeValue): KeyframeValue | Quat => {
    if (kind === "rotation") return eulerDegToQuat(v as Vec3);
    if (kind === "scale") return asScale(v);
    return v;
  };
  if (kfs.length === 1 || t <= first.t) return finish(first.value);
  if (t >= last.t) return finish(last.value);

  let i = 0;
  while (i < kfs.length - 2 && t >= kfs[i + 1]!.t) i++;
  const a = kfs[i]!;
  const b = kfs[i + 1]!;
  const span = b.t - a.t;
  const u = span <= 0 ? 1 : (t - a.t) / span;
  const e = easingFn(a.easing)(u);

  switch (kind) {
    case "boolean":
      return e >= 1 ? b.value : a.value;
    case "number":
      return lerp(a.value as number, b.value as number, e);
    case "color":
      return lerpColor(a.value as string, b.value as string, e);
    case "vec2": {
      const va = a.value as Vec2, vb = b.value as Vec2;
      return [lerp(va[0], vb[0], e), lerp(va[1], vb[1], e)];
    }
    case "scale":
      return v3.lerp(asScale(a.value), asScale(b.value), e);
    case "rotation": {
      if (track.interpolation === "slerp") {
        return slerp(eulerDegToQuat(a.value as Vec3), eulerDegToQuat(b.value as Vec3), e);
      }
      return eulerDegToQuat(v3.lerp(a.value as Vec3, b.value as Vec3, e));
    }
    case "vec3": {
      const useSpline =
        track.interpolation === "spline" || (track.interpolation === "auto" && isCameraPath && kfs.length >= 3);
      if (!useSpline) return v3.lerp(a.value as Vec3, b.value as Vec3, e);
      const p1 = a.value as Vec3, p2 = b.value as Vec3;
      const p0 = i > 0 ? (kfs[i - 1]!.value as Vec3) : v3.sub(v3.scale(p1, 2), p2);
      const p3 = i + 2 < kfs.length ? (kfs[i + 2]!.value as Vec3) : v3.sub(v3.scale(p2, 2), p1);
      return catmullRom(p0, p1, p2, p3, e);
    }
  }
}

/* ----------------------------------------------------------- base state */

function baseLight(l: Light): LightFrame {
  const f: LightFrame = { intensity: l.intensity, color: l.color };
  if (l.type === "hemisphere") f.groundColor = l.groundColor;
  if (l.type === "directional" || l.type === "spot" || l.type === "point") f.position = l.position;
  if (l.type === "directional" || l.type === "spot") f.target = l.target;
  if (l.type === "spot") {
    f.angle = l.angle;
    f.penumbra = l.penumbra;
  }
  return f;
}

export function baseFrame(scene: Scene): FrameState {
  const c = scene.camera;
  const nodes: Record<string, NodeFrame> = {};
  for (const n of scene.nodes) {
    if (n.kind === "text2d") {
      nodes[n.id] = {
        position: [0, 0, 0],
        quaternion: [0, 0, 0, 1],
        scale: [1, 1, 1],
        visible: n.visible,
        opacity: n.opacity,
        anchor: n.anchor,
        rotation: n.rotation,
        size: n.size,
        color: n.color,
      };
      continue;
    }
    const f: NodeFrame = {
      position: n.transform.position,
      quaternion: eulerDegToQuat(n.transform.rotation),
      scale: asScale(n.transform.scale),
      visible: n.visible,
      opacity: n.opacity,
    };
    if (n.kind === "device") {
      f.screenBrightness = n.screen.brightness;
      f.screenGlare = n.screen.glare;
      if (n.lidAngle !== undefined) f.lidAngle = n.lidAngle;
    }
    nodes[n.id] = f;
  }
  return {
    time: 0,
    camera: {
      position: c.position,
      target: c.target,
      roll: c.roll,
      fov: c.fov,
      orthoHeight: c.orthoHeight,
      dofFocusDistance: c.dof.focusDistance ?? v3.len(v3.sub(c.position, c.target)),
      dofAperture: c.dof.aperture,
    },
    lights: Object.fromEntries(scene.lights.map((l) => [l.id, baseLight(l)])),
    nodes,
  };
}

/* ------------------------------------------------------------- evaluate */

const NODE_FIELD: Record<string, keyof NodeFrame> = {
  position: "position",
  rotation: "quaternion",
  scale: "scale",
  opacity: "opacity",
  visible: "visible",
  "screen.brightness": "screenBrightness",
  "screen.glare": "screenGlare",
  lidAngle: "lidAngle",
  anchor: "anchor",
  size: "size",
  color: "color",
};

const CAMERA_FIELD: Record<string, keyof CameraFrame> = {
  position: "position",
  target: "target",
  roll: "roll",
  fov: "fov",
  orthoHeight: "orthoHeight",
  "dof.focusDistance": "dofFocusDistance",
  "dof.aperture": "dofAperture",
};

function roundDeep<T>(v: T): T {
  if (typeof v === "number") return round(v) as T;
  if (Array.isArray(v)) return v.map((x) => roundDeep(x)) as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = roundDeep(x);
    return out as T;
  }
  return v;
}

/**
 * Samples the whole timeline at time `t` (seconds). Pure and deterministic.
 * Tracks whose target or property is invalid are skipped (validation reports them).
 */
export function evaluateFrame(scene: Scene, t: number): FrameState {
  const frame = baseFrame(scene);
  frame.time = t;
  for (const track of scene.animation.tracks) {
    const ref = findTarget(scene, track.target);
    if (!ref) continue;
    const spec = animatableProperties(ref)[track.property];
    if (!spec) continue;
    const isCameraPath = ref.type === "camera" && (track.property === "position" || track.property === "target");
    const value = evaluateTrack(track, spec.kind, t, isCameraPath);

    if (ref.type === "camera") {
      const field = CAMERA_FIELD[track.property];
      if (field) (frame.camera as unknown as Record<string, unknown>)[field] = value;
    } else if (ref.type === "light") {
      const lf = frame.lights[ref.light.id];
      if (lf) (lf as unknown as Record<string, unknown>)[track.property] = value;
    } else {
      const nf = frame.nodes[ref.node.id];
      if (!nf) continue;
      // text2d 'rotation' is a plain number of degrees, not a 3D rotation.
      const field = ref.node.kind === "text2d" && track.property === "rotation" ? "rotation" : NODE_FIELD[track.property];
      if (field) (nf as unknown as Record<string, unknown>)[field] = value;
    }
  }
  // With DOF auto-focus and an animated camera, keep focus on the target.
  if (scene.camera.dof.focusDistance === undefined && !scene.animation.tracks.some((tr) => tr.target === "camera" && tr.property === "dof.focusDistance")) {
    frame.camera.dofFocusDistance = v3.len(v3.sub(frame.camera.position, frame.camera.target));
  }
  return roundDeep(frame);
}

/** Frame index -> time. Time for frame N is always N / fps. */
export function frameTime(frame: number, fps: number): number {
  return frame / fps;
}

export function frameCount(duration: number, fps: number): number {
  return Math.max(1, Math.round(duration * fps));
}
