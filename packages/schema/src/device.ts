import { z } from "zod";
import { Color, Id, Vec2 } from "./primitives.js";

/**
 * Data-driven device definitions. Geometry is generated procedurally from these numbers,
 * so adding a device is a JSON file, not code. All lengths are meters.
 */

export const DEVICE_CATEGORIES = ["smartphone", "tablet", "laptop", "monitor", "watch"] as const;
export const DeviceCategory = z.enum(DEVICE_CATEGORIES);
export type DeviceCategory = z.infer<typeof DeviceCategory>;

export const DeviceFinish = z.enum(["metal", "matte", "glossy"]);
export type DeviceFinish = z.infer<typeof DeviceFinish>;

export const DeviceColorVariant = z.object({
  name: Id,
  body: Color,
  finish: DeviceFinish.default("metal"),
});

export const SlabBody = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
  depth: z.number().positive(),
  cornerRadius: z.number().min(0).describe("Radius of the corners seen from the front."),
  edgeRadius: z.number().min(0).describe("Radius of the rounding between front/back faces and the sides."),
});

export const SlabScreen = z.object({
  width: z.number().positive().describe("Visible display width."),
  height: z.number().positive().describe("Visible display height."),
  cornerRadius: z.number().min(0),
  offset: Vec2.default([0, 0]).describe("Display center offset from the body center [x, y]."),
  pixels: z.tuple([z.number().int().positive(), z.number().int().positive()]).describe("Native resolution used for the screen texture."),
});

export const Cutout = z.object({
  type: z.enum(["island", "notch", "punch"]),
  width: z.number().positive(),
  height: z.number().positive(),
  offsetY: z.number().describe("Distance from the top edge of the display to the cutout's top edge."),
});

export const CameraBump = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
  depth: z.number().positive(),
  cornerRadius: z.number().min(0),
  position: Vec2.describe("Center of the bump on the back, relative to body center, as seen from the back [x, y]."),
  lenses: z
    .array(z.object({ position: Vec2.describe("Relative to bump center."), diameter: z.number().positive() }))
    .default([]),
});

export const SideButton = z.object({
  side: z.enum(["left", "right"]),
  offsetY: z.number().describe("Center of the button from the body top edge (positive downward)."),
  length: z.number().positive(),
  protrusion: z.number().positive(),
  thickness: z.number().positive(),
});

export const DeviceDefinition = z.object({
  id: Id,
  name: z.string(),
  category: DeviceCategory,
  form: z.literal("slab").default("slab").describe("Geometry builder. 'slab' covers phones, tablets and watches."),
  description: z.string().default(""),
  body: SlabBody,
  screen: SlabScreen,
  bezelColor: Color.default("#050505"),
  cutout: Cutout.optional(),
  cameraBump: CameraBump.optional(),
  buttons: z.array(SideButton).default([]),
  colors: z.array(DeviceColorVariant).min(1),
});
export type DeviceDefinition = z.infer<typeof DeviceDefinition>;
export type DeviceDefinitionInput = z.input<typeof DeviceDefinition>;
