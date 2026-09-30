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
  accent: Color.optional().describe("Secondary color, e.g. a watch band or laptop keyboard."),
});

export const SlabBody = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
  depth: z.number().positive(),
  cornerRadius: z.number().min(0).describe("Radius of the corners seen from the front."),
  edgeRadius: z.number().min(0).describe("Radius of the rounding between front/back faces and the sides."),
});
export type SlabBody = z.infer<typeof SlabBody>;

export const SlabScreen = z.object({
  width: z.number().positive().describe("Visible display width."),
  height: z.number().positive().describe("Visible display height."),
  cornerRadius: z.number().min(0),
  offset: Vec2.default([0, 0]).describe("Display center offset from the body (or lid/panel) center [x, y]."),
  pixels: z.tuple([z.number().int().positive(), z.number().int().positive()]).describe("Native resolution used for the screen texture."),
});
export type SlabScreen = z.infer<typeof SlabScreen>;

export const Cutout = z.object({
  type: z.enum(["island", "notch", "punch"]),
  width: z.number().positive(),
  height: z.number().positive(),
  offsetY: z.number().describe("Distance from the top edge of the display to the cutout's top edge (negative = overlaps the bezel)."),
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

const common = {
  id: Id,
  name: z.string(),
  category: DeviceCategory,
  description: z.string().default(""),
  screen: SlabScreen,
  bezelColor: Color.default("#050505"),
  cutout: Cutout.optional(),
  colors: z.array(DeviceColorVariant).min(1),
};

/** Phones and tablets: one rounded slab with a screen on the front. Origin: body center. */
export const SlabDevice = z.object({
  ...common,
  form: z.literal("slab"),
  body: SlabBody,
  cameraBump: CameraBump.optional(),
  buttons: z.array(SideButton).default([]),
});

/**
 * Laptops: a base and a hinged lid. Origin: center of the base. The lid is hinged at the back top edge
 * of the base; the node's `lidAngle` (0 = closed, 90 = upright, 180 = flat) sets how far it is open.
 */
export const LaptopDevice = z.object({
  ...common,
  form: z.literal("laptop"),
  base: z.object({
    width: z.number().positive(),
    depth: z.number().positive().describe("Front-to-back."),
    thickness: z.number().positive(),
    cornerRadius: z.number().min(0),
    edgeRadius: z.number().min(0),
  }),
  lid: z.object({
    height: z.number().positive().describe("From the hinge to the top edge."),
    thickness: z.number().positive(),
    cornerRadius: z.number().min(0),
    edgeRadius: z.number().min(0),
  }),
  keyboard: z.object({ width: z.number().positive(), depth: z.number().positive(), offset: z.number().describe("Center, from the base center toward the back (negative) or front (positive).") }),
  trackpad: z.object({ width: z.number().positive(), depth: z.number().positive(), offset: z.number() }),
  defaultLidAngle: z.number().min(0).max(180).default(110),
});

/** Desktop monitors: a thin panel on a stand. Origin: panel center. */
export const MonitorDevice = z.object({
  ...common,
  form: z.literal("monitor"),
  body: SlabBody,
  stand: z.object({
    neckWidth: z.number().positive(),
    neckDepth: z.number().positive(),
    neckHeight: z.number().positive().describe("From the panel's bottom edge to the top of the foot."),
    neckAttach: z.number().describe("Where the neck meets the panel back, from panel center (positive = up)."),
    footWidth: z.number().positive(),
    footDepth: z.number().positive(),
    footThickness: z.number().positive(),
  }),
});

/** Smartwatches: a small slab with a crown and two band straps. Origin: body center. */
export const WatchDevice = z.object({
  ...common,
  form: z.literal("watch"),
  body: SlabBody,
  crown: z.object({ diameter: z.number().positive(), length: z.number().positive(), offsetY: z.number() }),
  band: z.object({
    width: z.number().positive(),
    length: z.number().positive().describe("Length of each strap."),
    thickness: z.number().positive(),
    curl: z.number().min(0).max(180).default(150).describe("How far each strap bends back from the face, degrees (about 150 wraps it into a loop behind the case)."),
  }),
});

export const DeviceDefinition = z.discriminatedUnion("form", [SlabDevice, LaptopDevice, MonitorDevice, WatchDevice]);
export type DeviceDefinition = z.infer<typeof DeviceDefinition>;
export type DeviceDefinitionInput = z.input<typeof DeviceDefinition>;
export type SlabDeviceDef = z.infer<typeof SlabDevice>;
export type LaptopDeviceDef = z.infer<typeof LaptopDevice>;
export type MonitorDeviceDef = z.infer<typeof MonitorDevice>;
export type WatchDeviceDef = z.infer<typeof WatchDevice>;
