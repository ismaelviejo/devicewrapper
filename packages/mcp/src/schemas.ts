import { z } from "zod";
import {
  Background,
  Camera,
  Canvas,
  Color,
  DeviceNode,
  Effect,
  Environment,
  GroupNode,
  Id,
  Keyframe,
  PlaneNode,
  PrimitiveNode,
  RenderSettings,
  Screen,
  Text2dNode,
  Transform,
  Vec3,
} from "@devicewrapper/schema";

type AnyZ = z.ZodType;

/** Strips defaults/optionals so a schema can describe a partial patch. */
function unwrapDefaults(t: AnyZ): AnyZ {
  let cur: AnyZ = t;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (cur instanceof z.ZodDefault || cur instanceof z.ZodOptional) cur = cur.unwrap() as AnyZ;
    else break;
  }
  return cur;
}

/** Deep-partial version of an object schema, for merge-patch tool inputs. Descriptions are kept. */
export function patchOf<T extends z.ZodObject>(obj: T, omit: string[] = []): z.ZodObject {
  const shape: Record<string, AnyZ> = {};
  for (const [k, v] of Object.entries(obj.shape as Record<string, AnyZ>)) {
    if (omit.includes(k)) continue;
    const desc = v.description ?? unwrapDefaults(v).description;
    let inner = unwrapDefaults(v);
    if (inner instanceof z.ZodObject) inner = patchOf(inner);
    const field = inner.optional();
    shape[k] = desc ? field.describe(desc) : field;
  }
  return z.object(shape);
}

export const SceneId = Id.describe("Scene ID (see list_scenes).");
export const NodeId = Id.describe("Node ID (see list_nodes).");

export const CanvasPatch = patchOf(Canvas);
export const CameraPatch = patchOf(Camera);
export const EnvironmentPatch = patchOf(Environment);
export const RenderPatch = patchOf(RenderSettings);
export const TransformPatch = patchOf(Transform);
export const ScreenPatch = patchOf(Screen);

export { CANVAS_PRESETS } from "@devicewrapper/core";
import { CANVAS_PRESETS } from "@devicewrapper/core";
export const CanvasPreset = z.enum(Object.keys(CANVAS_PRESETS) as [keyof typeof CANVAS_PRESETS, ...Array<keyof typeof CANVAS_PRESETS>]);

/** New-node inputs: same as the scene schema, but `id` is optional (auto-assigned). */
export const NewPlane = PlaneNode.extend({ id: Id.optional().describe("Optional; auto-assigned if omitted.") });
export const NewPrimitive = PrimitiveNode.extend({ id: Id.optional().describe("Optional; auto-assigned if omitted.") });
export const NewGroup = GroupNode.extend({ id: Id.optional().describe("Optional; auto-assigned if omitted.") });
export const NewText = Text2dNode.extend({ id: Id.optional().describe("Optional; auto-assigned if omitted.") });
export const NewNode = z.discriminatedUnion("kind", [NewPlane, NewPrimitive, NewGroup, NewText]);

export const DeviceScreenInput = z
  .union([
    z.string().describe("Shortcut: an asset ID (image or video) or a workspace path to an image/video, imported automatically."),
    patchOf(Screen),
  ])
  .describe("Screen content. A string is an asset ID or a file path; or a full screen object.");

export { Background, Color, DeviceNode, Effect, Keyframe, Vec3 };

export const LightPatch = z
  .object({
    id: Id.describe("Light ID. Existing IDs are patched; new IDs are created (then 'type' is required)."),
    type: z.enum(["ambient", "hemisphere", "directional", "point", "spot"]).optional(),
    color: Color.optional(),
    groundColor: Color.optional().describe("hemisphere only"),
    intensity: z.number().min(0).optional(),
    position: Vec3.optional().describe("directional/point/spot"),
    target: Vec3.optional().describe("directional/spot"),
    castShadow: z.boolean().optional(),
    shadow: z.object({ softness: z.number().min(0).max(20).optional(), bias: z.number().optional(), mapSize: z.number().int().optional() }).optional(),
    angle: z.number().min(1).max(89).optional().describe("spot: cone half-angle, degrees"),
    penumbra: z.number().min(0).max(1).optional().describe("spot"),
    distance: z.number().min(0).optional().describe("point/spot: range, 0 = infinite"),
    decay: z.number().min(0).optional().describe("point/spot"),
  })
  .describe("A light, or a patch to an existing light.");

export const EffectPatch = z
  .object({
    type: z.enum(["vignette", "bloom", "fog", "grain"]),
    strength: z.number().optional(),
    color: Color.optional(),
    threshold: z.number().optional(),
    radius: z.number().optional(),
    near: z.number().optional(),
    far: z.number().optional(),
    amount: z.number().optional(),
  })
  .describe("Effect fields to set; unspecified fields keep their current or default values.");
