import type { Light, Node, Scene, Vec2, Vec3 } from "@devicewrapper/schema";

/**
 * Registry of animatable properties. This is the contract for `set_track`:
 * a track's `property` must be listed for its target, and keyframe values must match the kind.
 */
export type ValueKind = "number" | "boolean" | "vec2" | "vec3" | "rotation" | "scale" | "color";

export interface PropertySpec {
  kind: ValueKind;
  min?: number;
  max?: number;
  description: string;
}

const SPATIAL: Record<string, PropertySpec> = {
  position: { kind: "vec3", description: "Local position [x, y, z] in meters." },
  rotation: { kind: "rotation", description: "Local Euler rotation [x, y, z] in degrees." },
  scale: { kind: "scale", description: "Uniform number or [x, y, z]." },
  opacity: { kind: "number", min: 0, max: 1, description: "0..1." },
  visible: { kind: "boolean", description: "Shown or hidden (steps, no blending)." },
};

const DEVICE: Record<string, PropertySpec> = {
  ...SPATIAL,
  "screen.brightness": { kind: "number", min: 0, max: 3, description: "Screen brightness multiplier." },
  "screen.glare": { kind: "number", min: 0, max: 1, description: "Screen reflection strength." },
};

const TEXT: Record<string, PropertySpec> = {
  opacity: { kind: "number", min: 0, max: 1, description: "0..1." },
  visible: { kind: "boolean", description: "Shown or hidden." },
  anchor: { kind: "vec2", description: "Normalized canvas position [x, y]." },
  rotation: { kind: "number", description: "Degrees." },
  size: { kind: "number", min: 1, description: "Font size in pixels." },
  color: { kind: "color", description: "Hex color." },
};

const CAMERA: Record<string, PropertySpec> = {
  position: { kind: "vec3", description: "Camera position." },
  target: { kind: "vec3", description: "Look-at point." },
  roll: { kind: "number", description: "Roll around the view axis, degrees." },
  fov: { kind: "number", min: 1, max: 150, description: "Vertical field of view, degrees." },
  orthoHeight: { kind: "number", min: 0.0001, description: "Orthographic visible height, meters." },
  "dof.focusDistance": { kind: "number", min: 0.0001, description: "Focus distance, meters." },
  "dof.aperture": { kind: "number", min: 0, max: 1, description: "Blur strength." },
};

const LIGHT_COMMON: Record<string, PropertySpec> = {
  intensity: { kind: "number", min: 0, description: "Light intensity." },
  color: { kind: "color", description: "Light color." },
};

const LIGHTS: Record<Light["type"], Record<string, PropertySpec>> = {
  ambient: LIGHT_COMMON,
  hemisphere: { ...LIGHT_COMMON, groundColor: { kind: "color", description: "Ground color." } },
  directional: {
    ...LIGHT_COMMON,
    position: { kind: "vec3", description: "Light position (direction is position -> target)." },
    target: { kind: "vec3", description: "Point the light aims at." },
  },
  point: { ...LIGHT_COMMON, position: { kind: "vec3", description: "Light position." } },
  spot: {
    ...LIGHT_COMMON,
    position: { kind: "vec3", description: "Light position." },
    target: { kind: "vec3", description: "Point the light aims at." },
    angle: { kind: "number", min: 1, max: 89, description: "Cone half-angle, degrees." },
    penumbra: { kind: "number", min: 0, max: 1, description: "Edge softness." },
  },
};

export type TargetRef =
  | { type: "camera" }
  | { type: "node"; node: Node }
  | { type: "light"; light: Light };

export function findTarget(scene: Scene, target: string): TargetRef | null {
  if (target === "camera") return { type: "camera" };
  const node = scene.nodes.find((n) => n.id === target);
  if (node) return { type: "node", node };
  const light = scene.lights.find((l) => l.id === target);
  if (light) return { type: "light", light };
  return null;
}

export function animatableProperties(ref: TargetRef): Record<string, PropertySpec> {
  switch (ref.type) {
    case "camera":
      return CAMERA;
    case "light":
      return LIGHTS[ref.light.type];
    case "node":
      if (ref.node.kind === "device") return DEVICE;
      if (ref.node.kind === "text2d") return TEXT;
      return SPATIAL;
  }
}

/** Human/agent-readable table of everything animatable, served as a resource. */
export function animatableCatalog(): Record<string, Record<string, PropertySpec>> {
  return {
    camera: CAMERA,
    "device node": DEVICE,
    "plane / primitive / group node": SPATIAL,
    "text2d node": TEXT,
    ...Object.fromEntries(Object.entries(LIGHTS).map(([k, v]) => [`${k} light`, v])),
  };
}

export function isVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x));
}

export function isVec2(v: unknown): v is Vec2 {
  return Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "number" && Number.isFinite(x));
}

const HEX = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** Returns null if the value fits the spec, else a reason. */
export function checkValue(spec: PropertySpec, value: unknown): string | null {
  switch (spec.kind) {
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return "expected a number";
      if (spec.min !== undefined && value < spec.min) return `must be >= ${spec.min}`;
      if (spec.max !== undefined && value > spec.max) return `must be <= ${spec.max}`;
      return null;
    case "boolean":
      return typeof value === "boolean" ? null : "expected true or false";
    case "vec2":
      return isVec2(value) ? null : "expected [x, y]";
    case "vec3":
    case "rotation":
      return isVec3(value) ? null : "expected [x, y, z]";
    case "scale":
      if (typeof value === "number") return value > 0 ? null : "scale must be > 0";
      return isVec3(value) ? (value.every((x) => x > 0) ? null : "scale components must be > 0") : "expected a number or [x, y, z]";
    case "color":
      return typeof value === "string" && HEX.test(value) ? null : "expected a hex color like #ff8800";
  }
}
