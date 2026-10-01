import type { Scene, Vec3 } from "@devicewrapper/schema";
import { boundsOf, deviceSize, worldPoints } from "./bounds.js";
import type { DeviceRegistry } from "./devices.js";
import { DwError } from "./errors.js";
import { allocateId } from "./ids.js";
import { easingFn, quatRotate, v3 } from "./math.js";
import { addNode, setCamera, setTrack, updateNode, updateScene } from "./ops.js";
import { posedScene, screenFrameLocal, screenPoint, spliceTrack, toWorld, worldPose } from "./pose.js";
import { evaluateFrame } from "./timeline.js";
import { addMotionCues } from "./audio.js";

/**
 * Motion presets: named, parameterized animations built from keyframes relative to the target's
 * current (static) values. Deterministic: same scene + options = same tracks.
 */

type MotionKind = "device" | "camera";

export const MOTIONS: Record<string, { kind: MotionKind; description: string }> = {
  turntable: { kind: "device", description: "Full spin around the vertical axis (amount = degrees, default 360), constant speed." },
  "slow-turn": { kind: "device", description: "Gentle turn from -amount to +amount degrees around Y (default 15)." },
  float: { kind: "device", description: "Soft hovering up and down (amount = meters, default ~3% of device height)." },
  rise: { kind: "device", description: "Rises into place from below while fading in (entrance)." },
  "drop-in": { kind: "device", description: "Drops into place from above with a small overshoot (entrance)." },
  "enter-left": { kind: "device", description: "Slides in from the left while turning to face the camera (entrance)." },
  "enter-right": { kind: "device", description: "Slides in from the right while turning to face the camera (entrance)." },
  "exit-left": { kind: "device", description: "Slides out to the left (exit, at the end of the timeline)." },
  "exit-right": { kind: "device", description: "Slides out to the right (exit, at the end of the timeline)." },
  "fade-in": { kind: "device", description: "Opacity 0 → 1." },
  "fade-out": { kind: "device", description: "Opacity 1 → 0 at the end." },
  "spin-reveal": { kind: "device", description: "Starts showing its back, spins to face the camera (entrance)." },
  "tilt-up": { kind: "device", description: "Starts lying back, tilts up to face the camera (entrance)." },
  "lid-open": { kind: "device", description: "Laptops: opens the lid from closed to its resting angle." },
  "lid-close": { kind: "device", description: "Laptops: closes the lid (at the end)." },
  "screen-on": { kind: "device", description: "Screen brightness 0 → 1, like the display waking up." },
  "push-in": { kind: "camera", description: "Camera dollies toward its target (amount = fraction of distance, default 0.2)." },
  "pull-out": { kind: "camera", description: "Camera dollies away from its target (amount default 0.2)." },
  orbit: { kind: "camera", description: "Camera arcs around its target (amount = total degrees, default 30), eased." },
  "pan-left": { kind: "camera", description: "Camera and target slide left (amount = fraction of distance, default 0.12)." },
  "pan-right": { kind: "camera", description: "Camera and target slide right (amount default 0.12)." },
  "crane-up": { kind: "camera", description: "Camera rises while keeping its target (amount = fraction of distance, default 0.25)." },
  "zoom-in": { kind: "camera", description: "Narrows the field of view (amount = fraction, default 0.2)." },
  focus: {
    kind: "camera",
    description:
      "Camera rushes in to a point on a device's screen (target = device, default the one nearest the camera's aim; point = [x, y] on the display, 0..1 from top-left, default [0.5, 0.3]; amount = fraction of the screen height in view, default 0.4; angle = [yaw, pitch] off the screen normal, default [8, 4]), then holds `hold` seconds with a slow drift. Default 0.35 s, easeInOutExpo.",
  },
  reframe: {
    kind: "camera",
    description:
      "Camera pulls back out: to the scene's base camera, or to an auto-framed shot when shot / padding / shift are given (framed on the devices as they are posed at that moment), then holds `hold` seconds with a slow push. Default 0.45 s, easeInOutExpo.",
  },
};
export const MOTION_NAMES = Object.keys(MOTIONS);

export interface MotionOptions {
  preset: string;
  /** Node ID, 'camera', 'texts' (all text nodes), or omitted = all top-level devices (device motions) / the camera. */
  target?: string;
  start?: number;
  duration?: number;
  amount?: number;
  easing?: string;
  /** Seconds between devices when a device motion targets several devices. */
  stagger?: number;
  /** 'auto' wraps the target in a group if the property is already animated, so motions layer. */
  stack?: "auto" | "replace";
  /** focus: point on the display, [x, y] 0..1 from the top-left. */
  point?: [number, number];
  /** focus: [yaw, pitch] degrees off the screen normal. */
  angle?: [number, number];
  /** focus / reframe: seconds to hold after arriving (with a slow drift). */
  hold?: number;
  /** focus / reframe: how far the camera keeps moving during the hold, as a fraction of its distance. */
  drift?: number;
  /** reframe: auto-frame the devices with this shot instead of returning to the base camera. */
  shot?: string;
  padding?: number;
  shift?: [number, number];
  /** Add the motion's sound effect cues (default true). See assets/presets/motion-sounds.json. */
  sound?: boolean;
}

export interface MotionResult {
  scene: Scene;
  animated: Array<{ target: string; property: string; from: number; to: number }>;
  wrapped: Array<{ node: string; group: string }>;
  durationExtended?: number;
  /** Number of sound cues added. */
  sounds?: number;
}

const ENTRANCES = new Set(["rise", "drop-in", "enter-left", "enter-right", "fade-in", "spin-reveal", "tilt-up", "lid-open", "screen-on"]);
const EXITS = new Set(["exit-left", "exit-right", "fade-out", "lid-close"]);

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const vr = (v: Vec3): Vec3 => [r6(v[0]), r6(v[1]), r6(v[2])];

type Kf = { t: number; value: number | Vec3; easing?: string };

function timing(scene: Scene, preset: string, opts: MotionOptions): { start: number; duration: number } {
  const D = scene.canvas.duration;
  const entranceLen = Math.min(1.2, D);
  if (EXITS.has(preset)) {
    const duration = opts.duration ?? Math.min(1.0, D);
    return { start: opts.start ?? Math.max(0, D - duration), duration };
  }
  const start = opts.start ?? 0;
  const duration = opts.duration ?? (ENTRANCES.has(preset) ? (preset === "spin-reveal" || preset === "lid-open" ? Math.min(1.6, D) : entranceLen) : Math.max(0.1, D - start));
  return { start, duration };
}

/** Wraps a node in a new group (same parent) so a second motion can animate the group. */
function wrap(scene: Scene, nodeId: string, devices: DeviceRegistry): { scene: Scene; group: string } {
  const node = scene.nodes.find((n) => n.id === nodeId)!;
  const taken = new Set<string>(["camera", ...scene.nodes.map((n) => n.id), ...scene.lights.map((l) => l.id)]);
  const group = allocateId(`${nodeId}-motion`, taken);
  const parent = node.kind !== "text2d" ? node.parent : undefined;
  let s = addNode(scene, { id: group, kind: "group", ...(parent ? { parent } : {}) }, devices).scene;
  s = updateNode(s, nodeId, { parent: group }, devices);
  // Keep the group next to its child in node order (tidier summaries).
  const g = s.nodes.find((n) => n.id === group)!;
  const rest = s.nodes.filter((n) => n.id !== group);
  const idx = rest.findIndex((n) => n.id === nodeId);
  rest.splice(idx, 0, g);
  return { scene: { ...s, nodes: rest }, group };
}

/** Group that target 'all' puts the top-level devices in, so an arrangement moves as one unit. */
export const ARRANGEMENT = "arrangement";

/** Puts every top-level device (and device group) in one group centered under them; reuses it if present. */
function groupAll(scene: Scene, devices: DeviceRegistry): { scene: Scene; group: string } {
  if (scene.nodes.some((n) => n.id === ARRANGEMENT && n.kind === "group")) return { scene, group: ARRANGEMENT };
  const hasDevice = (id: string): boolean => scene.nodes.some((n) => n.kind !== "text2d" && n.parent === id && (n.kind === "device" || hasDevice(n.id)));
  const members = scene.nodes.filter((n) => n.kind !== "text2d" && !n.parent && (n.kind === "device" || (n.kind === "group" && hasDevice(n.id))));
  if (members.length === 0) throw new DwError("NOTHING_TO_ANIMATE", "There are no devices to animate.");
  const ids = scene.nodes.filter((n) => n.kind === "device").map((n) => n.id);
  const box = boundsOf(worldPoints(scene, ids, devices))!;
  const c: Vec3 = [(box.min[0] + box.max[0]) / 2, 0, (box.min[2] + box.max[2]) / 2].map((v) => Math.round(v * 1e6) / 1e6) as Vec3;
  let s = addNode(scene, { id: ARRANGEMENT, kind: "group", transform: { position: c } }, devices).scene;
  for (const m of members) {
    if (m.kind === "text2d") continue;
    const p = m.transform.position;
    s = updateNode(s, m.id, { parent: ARRANGEMENT, transform: { position: [p[0] - c[0], p[1] - c[1], p[2] - c[2]].map((v) => Math.round(v * 1e6) / 1e6) } }, devices);
  }
  // Existing position tracks were absolute; they are now relative to the group.
  const memberIds = new Set(members.map((m) => m.id));
  const tracks = s.animation.tracks.map((t) =>
    memberIds.has(t.target) && t.property === "position"
      ? { ...t, keyframes: t.keyframes.map((k) => ({ ...k, value: (k.value as number[]).map((v, i) => Math.round((v - c[i]!) * 1e6) / 1e6) })) }
      : t,
  );
  s = { ...s, animation: { ...s.animation, tracks: tracks as typeof s.animation.tracks } };
  return { scene: s, group: ARRANGEMENT };
}

function nodeKeyframes(scene: Scene, preset: string, targetId: string, start: number, duration: number, amount: number | undefined, easing: string | undefined, devices: DeviceRegistry, useIdentity: boolean, sizeOf: string = targetId): Array<{ property: string; keyframes: Kf[]; interpolation?: "linear" | "spline" }> {
  const node = scene.nodes.find((n) => n.id === targetId);
  if (!node || node.kind === "text2d") throw new DwError("INVALID_MOTION_TARGET", `Motion '${preset}' needs a 3D node; '${targetId}' is ${node ? "a text node" : "missing"}.`);
  const pos: Vec3 = useIdentity ? [0, 0, 0] : node.transform.position;
  const rot: Vec3 = useIdentity ? [0, 0, 0] : node.transform.rotation;
  const sizeNode = scene.nodes.find((n) => n.id === sizeOf) ?? node;
  const size: Vec3 = sizeNode.kind === "device" ? deviceSize(devices.require(sizeNode.model), sizeNode.lidAngle) : [0.1, 0.15, 0.01];
  const t0 = start, t1 = start + duration;
  const ez = (fallback: string) => easing ?? fallback;
  switch (preset) {
    case "turntable": {
      const a = amount ?? 360;
      return [{ property: "rotation", keyframes: [{ t: t0, value: rot, easing: ez("linear") }, { t: t1, value: vr([rot[0], rot[1] + a, rot[2]]) }] }];
    }
    case "slow-turn": {
      const a = amount ?? 15;
      return [{ property: "rotation", keyframes: [{ t: t0, value: vr([rot[0], rot[1] - a, rot[2]]), easing: ez("easeInOutSine") }, { t: t1, value: vr([rot[0], rot[1] + a, rot[2]]) }] }];
    }
    case "float": {
      // Smooth bob between -a and +a, about one cycle per 2.5 s, eased at each extreme (sine-like).
      const a = amount ?? size[1] * 0.03;
      const halfCycles = 2 * Math.max(1, Math.round(duration / 2.5));
      const kfs: Kf[] = [];
      for (let k = 0; k <= halfCycles; k++) {
        kfs.push({ t: r6(t0 + (duration * k) / halfCycles), value: vr([pos[0], pos[1] + (k % 2 === 0 ? -a : a), pos[2]]), easing: "easeInOutSine" });
      }
      return [{ property: "position", keyframes: kfs }];
    }
    case "rise":
    case "drop-in": {
      const a = amount ?? size[1] * 0.6;
      const dir = preset === "rise" ? -1 : 1;
      return [
        { property: "position", keyframes: [{ t: t0, value: vr([pos[0], pos[1] + dir * a, pos[2]]), easing: ez(preset === "rise" ? "easeOutCubic" : "easeOutBack") }, { t: t1, value: pos }] },
        { property: "opacity", keyframes: [{ t: t0, value: 0, easing: "easeOutQuad" }, { t: r6(t0 + duration * 0.6), value: 1 }] },
      ];
    }
    case "enter-left":
    case "enter-right":
    case "exit-left":
    case "exit-right": {
      const side = preset.endsWith("left") ? -1 : 1;
      const a = amount ?? size[0] * 4;
      const off = vr([pos[0] + side * a, pos[1], pos[2]]);
      const turned = vr([rot[0], rot[1] + side * 28, rot[2]]);
      const entering = preset.startsWith("enter");
      return [
        { property: "position", keyframes: entering ? [{ t: t0, value: off, easing: ez("easeOutCubic") }, { t: t1, value: pos }] : [{ t: t0, value: pos, easing: ez("easeInCubic") }, { t: t1, value: off }] },
        { property: "rotation", keyframes: entering ? [{ t: t0, value: turned, easing: ez("easeOutCubic") }, { t: t1, value: rot }] : [{ t: t0, value: rot, easing: ez("easeInCubic") }, { t: t1, value: turned }] },
      ];
    }
    case "fade-in":
      return [{ property: "opacity", keyframes: [{ t: t0, value: 0, easing: ez("easeOutQuad") }, { t: t1, value: 1 }] }];
    case "fade-out":
      return [{ property: "opacity", keyframes: [{ t: t0, value: 1, easing: ez("easeInQuad") }, { t: t1, value: 0 }] }];
    case "spin-reveal":
      return [{ property: "rotation", keyframes: [{ t: t0, value: vr([rot[0], rot[1] - (amount ?? 180), rot[2]]), easing: ez("easeOutCubic") }, { t: t1, value: rot }] }];
    case "tilt-up":
      return [{ property: "rotation", keyframes: [{ t: t0, value: vr([rot[0] - (amount ?? 60), rot[1], rot[2]]), easing: ez("easeOutCubic") }, { t: t1, value: rot }] }];
    case "lid-open":
    case "lid-close": {
      if (node.kind !== "device") throw new DwError("INVALID_MOTION_TARGET", `'${preset}' needs a laptop device.`);
      const def = devices.require(node.model);
      if (def.form !== "laptop") throw new DwError("INVALID_MOTION_TARGET", `'${preset}' only works on laptops; '${targetId}' is a ${def.category}.`);
      const open = node.lidAngle ?? def.defaultLidAngle;
      const closed = amount ?? 0;
      return [{ property: "lidAngle", keyframes: preset === "lid-open" ? [{ t: t0, value: closed, easing: ez("easeInOutCubic") }, { t: t1, value: open }] : [{ t: t0, value: open, easing: ez("easeInOutCubic") }, { t: t1, value: closed }] }];
    }
    case "screen-on":
      if (node.kind !== "device") throw new DwError("INVALID_MOTION_TARGET", "'screen-on' needs a device.");
      return [{ property: "screen.brightness", keyframes: [{ t: t0, value: 0, easing: ez("easeOutQuad") }, { t: t1, value: node.screen.brightness }] }];
    default:
      throw new DwError("UNKNOWN_MOTION", `Unknown motion '${preset}'.`);
  }
}

const TEXT_MOTIONS = new Set(["fade-in", "fade-out", "rise", "drop-in", "enter-left", "enter-right", "exit-left", "exit-right"]);

/** Text motions animate the 2D anchor (normalized canvas coords) and opacity. */
function textKeyframes(scene: Scene, preset: string, targetId: string, start: number, duration: number, amount: number | undefined, easing: string | undefined): Array<{ property: string; keyframes: Kf[] }> {
  const node = scene.nodes.find((n) => n.id === targetId);
  if (!node || node.kind !== "text2d") throw new DwError("INVALID_MOTION_TARGET", `'${targetId}' is not a text node.`);
  if (!TEXT_MOTIONS.has(preset)) {
    throw new DwError("INVALID_MOTION_TARGET", `Motion '${preset}' does not apply to text. Text motions: ${[...TEXT_MOTIONS].join(", ")}.`);
  }
  const [x, y] = node.anchor;
  const t0 = start, t1 = start + duration;
  const ez = (fallback: string) => easing ?? fallback;
  const fadeIn: Kf[] = [{ t: t0, value: 0, easing: "easeOutQuad" }, { t: r6(t0 + duration * 0.7), value: node.opacity }];
  switch (preset) {
    case "fade-in":
      return [{ property: "opacity", keyframes: [{ t: t0, value: 0, easing: ez("easeOutQuad") }, { t: t1, value: node.opacity }] }];
    case "fade-out":
      return [{ property: "opacity", keyframes: [{ t: t0, value: node.opacity, easing: ez("easeInQuad") }, { t: t1, value: 0 }] }];
    case "rise":
    case "drop-in": {
      const d = (amount ?? 0.04) * (preset === "rise" ? 1 : -1);
      return [
        { property: "anchor", keyframes: [{ t: t0, value: [r6(x), r6(y + d)] as never, easing: ez("easeOutCubic") }, { t: t1, value: [x, y] as never }] },
        { property: "opacity", keyframes: fadeIn },
      ];
    }
    default: {
      const side = preset.endsWith("left") ? -1 : 1;
      const off: [number, number] = [r6(x + side * (amount ?? 0.25)), y];
      const entering = preset.startsWith("enter");
      return [
        { property: "anchor", keyframes: entering ? [{ t: t0, value: off as never, easing: ez("easeOutCubic") }, { t: t1, value: [x, y] as never }] : [{ t: t0, value: [x, y] as never, easing: ez("easeInCubic") }, { t: t1, value: off as never }] },
        { property: "opacity", keyframes: entering ? fadeIn : [{ t: t0, value: node.opacity, easing: "easeInQuad" }, { t: t1, value: 0 }] },
      ];
    }
  }
}

function cameraKeyframes(scene: Scene, preset: string, start: number, duration: number, amount: number | undefined, easing: string | undefined): Array<{ property: string; keyframes: Kf[]; interpolation?: "linear" | "spline" }> {
  const c = scene.camera;
  const t0 = start, t1 = start + duration;
  const toTarget = v3.sub(c.target, c.position);
  const dist = v3.len(toTarget);
  const fwd = v3.norm(toTarget);
  let up: Vec3 = [0, 1, 0];
  if (Math.abs(v3.dot(fwd, up)) > 0.999) up = [0, 0, -1];
  const right = v3.norm(v3.cross(fwd, up));
  const ez = easing ?? "easeInOutSine";
  switch (preset) {
    case "push-in":
    case "pull-out": {
      const a = (amount ?? 0.2) * (preset === "push-in" ? 1 : -1);
      return [{ property: "position", interpolation: "linear", keyframes: [{ t: t0, value: c.position, easing: ez }, { t: t1, value: vr(v3.add(c.position, v3.scale(toTarget, a))) }] }];
    }
    case "orbit": {
      const total = ((amount ?? 30) * Math.PI) / 180;
      const off = v3.sub(c.position, c.target);
      const ease = easingFn(ez as never);
      const samples = 9;
      const kfs: Kf[] = [];
      for (let k = 0; k < samples; k++) {
        const u = k / (samples - 1);
        const a = total * (ease(u) - 0.5);
        const cs = Math.cos(a), sn = Math.sin(a);
        const p: Vec3 = [off[0] * cs + off[2] * sn, off[1], -off[0] * sn + off[2] * cs];
        kfs.push({ t: r6(t0 + duration * u), value: vr(v3.add(c.target, p)), easing: "linear" });
      }
      return [{ property: "position", interpolation: "spline", keyframes: kfs }];
    }
    case "pan-left":
    case "pan-right": {
      const d = v3.scale(right, (preset === "pan-left" ? -1 : 1) * (amount ?? 0.12) * dist);
      return [
        { property: "position", interpolation: "linear", keyframes: [{ t: t0, value: c.position, easing: ez }, { t: t1, value: vr(v3.add(c.position, d)) }] },
        { property: "target", interpolation: "linear", keyframes: [{ t: t0, value: c.target, easing: ez }, { t: t1, value: vr(v3.add(c.target, d)) }] },
      ];
    }
    case "crane-up":
      return [{ property: "position", interpolation: "linear", keyframes: [{ t: t0, value: c.position, easing: ez }, { t: t1, value: vr(v3.add(c.position, [0, (amount ?? 0.25) * dist, 0])) }] }];
    case "zoom-in":
      return [{ property: "fov", keyframes: [{ t: t0, value: c.fov, easing: ez }, { t: t1, value: r6(c.fov * (1 - (amount ?? 0.2))) }] }];
    default:
      throw new DwError("UNKNOWN_MOTION", `Unknown motion '${preset}'.`);
  }
}

/**
 * The device a device-relative motion acts on: `target`, or the scene's only device. With several
 * devices, `nearest` picks the one closest to where the camera looks; otherwise it's an error.
 */
export function resolveDevice(scene: Scene, target: string | undefined, what: string, nearest = false): string {
  if (target) {
    const n = scene.nodes.find((x) => x.id === target);
    if (!n || n.kind !== "device") throw new DwError("INVALID_MOTION_TARGET", `${what} needs a device as target; '${target}' is ${n ? `a ${n.kind}` : "missing"}.`);
    return target;
  }
  const ids = scene.nodes.filter((n) => n.kind === "device").map((n) => n.id);
  if (ids.length === 0) throw new DwError("NOTHING_TO_ANIMATE", "There are no devices in the scene.");
  if (ids.length > 1 && nearest) {
    const d = (id: string) => v3.len(v3.sub(worldPose(scene, id).p, scene.camera.target));
    return [...ids].sort((a, b) => d(a) - d(b))[0]!;
  }
  if (ids.length > 1) throw new DwError("AMBIGUOUS_TARGET", `${what} needs to know which device to use: ${ids.join(", ")}.`, { hint: "Pass target: '<device id>'." });
  return ids[0]!;
}

/**
 * focus / reframe: camera moves defined by what the camera should see when it arrives, computed from
 * the devices' animated pose at that moment, so they fit any device and any screenshot. Both splice
 * into existing camera tracks (only their own time window changes), so moves chain on one timeline.
 */
function cameraMove(scene: Scene, opts: MotionOptions, devices: DeviceRegistry): MotionResult {
  const focus = opts.preset === "focus";
  const start = opts.start ?? 0;
  const duration = opts.duration ?? (focus ? 0.35 : 0.45);
  const hold = opts.hold ?? 0;
  if (hold < 0) throw new DwError("INVALID_VALUE", "hold must be >= 0 seconds.", { path: "hold" });
  const ez = opts.easing ?? "easeInOutExpo";
  const tArrive = start + duration, tEnd = tArrive + hold;
  const now = evaluateFrame(scene, start).camera;
  const at = evaluateFrame(scene, tArrive);
  let arrive: { position: Vec3; target: Vec3 };
  let settle: Vec3;
  if (focus) {
    const id = resolveDevice(scene, opts.target === "camera" ? undefined : opts.target, "'focus'", true);
    const node = scene.nodes.find((n) => n.id === id);
    if (node?.kind !== "device") throw new DwError("INVALID_MOTION_TARGET", `'focus' needs a device; '${id}' is not one.`);
    const def = devices.require(node.model);
    const point = opts.point ?? [0.5, 0.3];
    if (point.some((v) => v < 0 || v > 1)) throw new DwError("INVALID_VALUE", `point must be [x, y] between 0 and 1 (got ${JSON.stringify(point)}).`, { path: "point" });
    const amount = opts.amount ?? 0.4;
    if (!(amount > 0)) throw new DwError("INVALID_VALUE", "amount (fraction of the screen height in view) must be > 0.", { path: "amount" });
    const sf = screenFrameLocal(def, at.nodes[id]?.lidAngle ?? node.lidAngle);
    const pose = worldPose(scene, id, tArrive);
    const P = toWorld(pose, screenPoint(sf, point));
    const [yaw, pitch] = (opts.angle ?? [8, 4]).map((d) => (d * Math.PI) / 180) as [number, number];
    const dLocal = v3.add(v3.add(v3.scale(sf.right, Math.sin(yaw) * Math.cos(pitch)), v3.scale(sf.up, Math.sin(pitch))), v3.scale(sf.normal, Math.cos(yaw) * Math.cos(pitch)));
    const dir = v3.norm(quatRotate(pose.q, dLocal));
    const dist = (amount * sf.height * pose.s) / 2 / Math.tan((at.camera.fov * Math.PI) / 360);
    arrive = { target: vr(P), position: vr(v3.add(P, v3.scale(dir, dist))) };
    settle = vr(v3.add(P, v3.scale(dir, dist * (1 - (opts.drift ?? 0.1)))));
  } else {
    let cam = scene.camera;
    if (opts.shot !== undefined || opts.padding !== undefined || opts.shift !== undefined) {
      const posed = posedScene(scene, tArrive);
      const targets = opts.target && opts.target !== "camera" ? [opts.target] : undefined;
      cam = setCamera(posed, { frame: { shot: (opts.shot ?? "hero") as never, ...(targets ? { targets } : {}), ...(opts.padding !== undefined ? { padding: opts.padding } : {}), ...(opts.shift ? { shift: opts.shift } : {}) } }, devices).camera;
    }
    arrive = { position: cam.position, target: cam.target };
    settle = vr(v3.add(cam.position, v3.scale(v3.sub(cam.target, cam.position), opts.drift ?? 0.05)));
  }
  const kf = (from: Vec3, to: Vec3, end: Vec3): Kf[] => [
    { t: r6(start), value: vr(from), easing: ez },
    { t: r6(tArrive), value: to, easing: hold > 0 ? "linear" : ez },
    ...(hold > 0 ? [{ t: r6(tEnd), value: end, easing: ez }] : []),
  ];
  let s = scene;
  for (const [property, keyframes] of [
    ["position", kf(now.position, arrive.position, settle)],
    ["target", kf(now.target, arrive.target, arrive.target)],
  ] as const) {
    const existing = s.animation.tracks.find((t) => t.target === "camera" && t.property === property);
    // Sharp moves: straight lines with eased timing, unless the track is an explicit spline (e.g. an orbit).
    const interpolation = !existing || existing.interpolation === "auto" ? "linear" : undefined;
    s = spliceTrack(s, "camera", property, keyframes as never, [start, tEnd], interpolation);
  }
  const result: MotionResult = {
    scene: s,
    animated: [
      { target: "camera", property: "position", from: start, to: tEnd },
      { target: "camera", property: "target", from: start, to: tEnd },
    ],
    wrapped: [],
  };
  if (tEnd > s.canvas.duration + 1e-9) {
    const d = Math.ceil(tEnd * 100) / 100;
    result.scene = updateScene(s, { canvas: { duration: d } });
    result.durationExtended = d;
  }
  return result;
}

export function applyMotion(scene: Scene, opts: MotionOptions, devices: DeviceRegistry): MotionResult {
  const spec = MOTIONS[opts.preset];
  if (!spec) throw new DwError("UNKNOWN_MOTION", `Unknown motion '${opts.preset}'. Use one of: ${MOTION_NAMES.join(", ")}.`);
  if (opts.preset === "focus" || opts.preset === "reframe") return cameraMove(scene, opts, devices);
  let s = scene;
  const { start, duration } = timing(s, opts.preset, opts);
  const animated: MotionResult["animated"] = [];
  const wrapped: MotionResult["wrapped"] = [];
  let latest = 0;
  let soundCount = 0;

  if (spec.kind === "camera") {
    if (opts.target && opts.target !== "camera") throw new DwError("INVALID_MOTION_TARGET", `'${opts.preset}' is a camera motion; omit target or use 'camera'.`);
    for (const tr of cameraKeyframes(s, opts.preset, start, duration, opts.amount, opts.easing)) {
      s = setTrack(s, { target: "camera", property: tr.property, keyframes: tr.keyframes as never, ...(tr.interpolation ? { interpolation: tr.interpolation } : {}) });
      animated.push({ target: "camera", property: tr.property, from: start, to: start + duration });
    }
    latest = start + duration;
  } else if (opts.target === "texts" || (opts.target && s.nodes.find((n) => n.id === opts.target)?.kind === "text2d")) {
    const ids = opts.target === "texts" ? s.nodes.filter((n) => n.kind === "text2d").map((n) => n.id) : [opts.target!];
    if (ids.length === 0) throw new DwError("NOTHING_TO_ANIMATE", "There are no text nodes.");
    const stagger = opts.stagger ?? (ids.length > 1 ? 0.15 : 0);
    ids.forEach((id, k) => {
      const st = r6(start + stagger * k);
      for (const tr of textKeyframes(s, opts.preset, id, st, duration, opts.amount, opts.easing)) {
        s = setTrack(s, { target: id, property: tr.property, keyframes: tr.keyframes as never });
        animated.push({ target: id, property: tr.property, from: st, to: st + duration });
      }
      latest = Math.max(latest, st + duration);
    });
  } else {
    let targets: string[];
    if (opts.target === "camera") throw new DwError("INVALID_MOTION_TARGET", `'${opts.preset}' animates devices, not the camera.`);
    if (opts.target === "all") {
      const g = groupAll(s, devices);
      s = g.scene;
      targets = [g.group];
    } else if (opts.target) {
      if (!s.nodes.some((n) => n.id === opts.target)) throw new DwError("UNKNOWN_NODE", `No node '${opts.target}'.`, { hint: "Use a node ID, 'all' (every device as one unit), 'texts', or omit target." });
      targets = [opts.target];
    } else {
      // Top-level devices, and top-level groups that contain devices (e.g. the carousel ring).
      const hasDevice = (id: string): boolean => s.nodes.some((n) => n.kind !== "text2d" && n.parent === id && (n.kind === "device" || hasDevice(n.id)));
      targets = s.nodes.filter((n) => n.kind !== "text2d" && !n.parent && (n.kind === "device" || (n.kind === "group" && hasDevice(n.id)))).map((n) => n.id);
      if (targets.length === 0) targets = s.nodes.filter((n) => n.kind === "device").map((n) => n.id);
      if (targets.length === 0) throw new DwError("NOTHING_TO_ANIMATE", "There are no devices to animate.");
      // Laptop-only motions apply to laptops only when no target is given.
      if (opts.preset.startsWith("lid-")) targets = targets.filter((id) => {
        const n = s.nodes.find((x) => x.id === id);
        return n?.kind === "device" && devices.get(n.model)?.form === "laptop";
      });
    }
    const stagger = opts.stagger ?? (ENTRANCES.has(opts.preset) && targets.length > 1 ? 0.12 : 0);
    const runs: Array<{ target: string; start: number }> = [];
    targets.forEach((target, k) => {
      const st = r6(start + stagger * k);
      runs.push({ target, start: st });
      const props = nodeKeyframes(s, opts.preset, target, st, duration, opts.amount, opts.easing, devices, false).map((p) => p.property);
      let animTarget = target;
      let identity = false;
      const clash = props.some((p) => s.animation.tracks.some((t) => t.target === target && t.property === p));
      if (clash && (opts.stack ?? "auto") === "auto" && !props.includes("lidAngle") && !props.includes("screen.brightness")) {
        const w = wrap(s, target, devices);
        s = w.scene;
        animTarget = w.group;
        identity = true;
        wrapped.push({ node: target, group: w.group });
      }
      const tracks = nodeKeyframes(s, opts.preset, animTarget, st, duration, opts.amount, opts.easing, devices, identity, target);
      for (const tr of tracks) {
        s = setTrack(s, { target: animTarget, property: tr.property, keyframes: tr.keyframes as never, ...(tr.interpolation ? { interpolation: tr.interpolation } : {}) });
        animated.push({ target: animTarget, property: tr.property, from: st, to: st + duration });
      }
      latest = Math.max(latest, st + duration);
    });
    if (opts.sound ?? true) {
      const r = addMotionCues(s, opts.preset, runs, duration);
      s = r.scene;
      soundCount = r.added;
    }
  }
  const result: MotionResult = { scene: s, animated, wrapped, ...(soundCount ? { sounds: soundCount } : {}) };
  if (latest > s.canvas.duration + 1e-9) {
    const d = Math.ceil(latest * 100) / 100;
    result.scene = updateScene(s, { canvas: { duration: d } });
    result.durationExtended = d;
  }
  return result;
}
