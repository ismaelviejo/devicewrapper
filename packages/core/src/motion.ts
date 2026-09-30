import type { Scene, Vec3 } from "@devicewrapper/schema";
import { deviceSize } from "./bounds.js";
import type { DeviceRegistry } from "./devices.js";
import { DwError } from "./errors.js";
import { allocateId } from "./ids.js";
import { easingFn, v3 } from "./math.js";
import { addNode, setTrack, updateNode, updateScene } from "./ops.js";

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
}

export interface MotionResult {
  scene: Scene;
  animated: Array<{ target: string; property: string; from: number; to: number }>;
  wrapped: Array<{ node: string; group: string }>;
  durationExtended?: number;
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

export function applyMotion(scene: Scene, opts: MotionOptions, devices: DeviceRegistry): MotionResult {
  const spec = MOTIONS[opts.preset];
  if (!spec) throw new DwError("UNKNOWN_MOTION", `Unknown motion '${opts.preset}'. Use one of: ${MOTION_NAMES.join(", ")}.`);
  let s = scene;
  const { start, duration } = timing(s, opts.preset, opts);
  const animated: MotionResult["animated"] = [];
  const wrapped: MotionResult["wrapped"] = [];
  let latest = 0;

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
      const st = start + stagger * k;
      for (const tr of textKeyframes(s, opts.preset, id, st, duration, opts.amount, opts.easing)) {
        s = setTrack(s, { target: id, property: tr.property, keyframes: tr.keyframes as never });
        animated.push({ target: id, property: tr.property, from: st, to: st + duration });
      }
      latest = Math.max(latest, st + duration);
    });
  } else {
    let targets: string[];
    if (opts.target === "camera") throw new DwError("INVALID_MOTION_TARGET", `'${opts.preset}' animates devices, not the camera.`);
    if (opts.target) {
      if (!s.nodes.some((n) => n.id === opts.target)) throw new DwError("UNKNOWN_NODE", `No node '${opts.target}'.`);
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
    targets.forEach((target, k) => {
      const st = start + stagger * k;
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
  }
  const result: MotionResult = { scene: s, animated, wrapped };
  if (latest > s.canvas.duration + 1e-9) {
    const d = Math.ceil(latest * 100) / 100;
    result.scene = updateScene(s, { canvas: { duration: d } });
    result.durationExtended = d;
  }
  return result;
}
