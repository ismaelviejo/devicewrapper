import { z } from "zod";

/** Identifier for scenes, nodes, lights, materials, assets and tracks. */
export const Id = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/, "IDs use letters, digits, '-' or '_', start with a letter or digit, max 64 chars")
  .describe("Stable identifier. Letters, digits, '-' and '_'.");
export type Id = z.infer<typeof Id>;

export const Vec2 = z.tuple([z.number().finite(), z.number().finite()]);
export type Vec2 = z.infer<typeof Vec2>;

export const Vec3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
export type Vec3 = z.infer<typeof Vec3>;

/** Quaternion [x, y, z, w]. Only used in evaluated frame state, never in scene JSON. */
export const Quat = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export type Quat = z.infer<typeof Quat>;

export const Color = z
  .string()
  .regex(/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, "Colors are hex strings: #rrggbb or #rrggbbaa")
  .describe("Hex color, #rrggbb or #rrggbbaa");
export type Color = z.infer<typeof Color>;

export const Transform = z
  .object({
    position: Vec3.default([0, 0, 0]).describe("Position in meters [x, y, z]. +Y is up, +Z points toward the default camera."),
    rotation: Vec3.default([0, 0, 0]).describe("Euler rotation in degrees [x, y, z], applied in XYZ order."),
    scale: z.union([z.number().positive(), Vec3]).default(1).describe("Uniform scale or [x, y, z]."),
  })
  .describe("Local transform relative to the parent node (or the world).");
export type Transform = z.infer<typeof Transform>;
export type TransformInput = z.input<typeof Transform>;

export const EASINGS = [
  "linear",
  "step",
  "easeIn",
  "easeOut",
  "easeInOut",
  "easeInQuad",
  "easeOutQuad",
  "easeInOutQuad",
  "easeInCubic",
  "easeOutCubic",
  "easeInOutCubic",
  "easeInSine",
  "easeOutSine",
  "easeInOutSine",
  "easeInExpo",
  "easeOutExpo",
  "easeInOutExpo",
  "easeOutBack",
] as const;

export const EasingName = z.enum(EASINGS);
export type EasingName = z.infer<typeof EasingName>;

export const CubicBezier = z
  .object({ cubicBezier: z.tuple([z.number().min(0).max(1), z.number(), z.number().min(0).max(1), z.number()]) })
  .describe("CSS-style cubic-bezier(x1, y1, x2, y2).");

export const Easing = z.union([EasingName, CubicBezier]).describe(
  "Easing for the segment that STARTS at this keyframe. A named easing or { cubicBezier: [x1,y1,x2,y2] }.",
);
export type Easing = z.infer<typeof Easing>;
