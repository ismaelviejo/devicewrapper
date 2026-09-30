import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Background, Color, Effect, Environment, type Scene } from "@devicewrapper/schema";
import { z } from "zod";
import { BUILTIN_ASSETS_DIR, type DeviceRegistry } from "./devices.js";
import { DwError, schemaError } from "./errors.js";
import { setFloor, type FloorSpec } from "./layout.js";
import { setBackground, setEffects, setLights, updateNode } from "./ops.js";
import { LIGHTING_PRESET_NAMES } from "./presets.js";

/** Floor choices shared by styles, apply_style and set_floor-like options. */
export const FloorSpecSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("none") }),
    z.object({ type: z.literal("shadow"), opacity: z.number().min(0).max(1).optional() }),
    z.object({ type: z.literal("solid"), color: Color, roughness: z.number().min(0).max(1).optional(), metalness: z.number().min(0).max(1).optional() }),
    z.object({
      type: z.literal("reflective"),
      strength: z.number().min(0).max(1).optional(),
      blur: z.number().min(0).max(1).optional(),
      fade: z.number().min(0).max(1).optional(),
      shadowOpacity: z.number().min(0).max(1).optional(),
    }),
  ])
  .describe("none; shadow (invisible floor with a soft contact shadow); solid (visible colored floor); reflective (glossy mirror image of the devices over the background, plus a shadow).");

const StyleSchema = z.object({
  description: z.string(),
  background: Background,
  lighting: z.string(),
  lightOverrides: z.array(z.record(z.string(), z.unknown())).default([]),
  environment: Environment.optional(),
  floor: FloorSpecSchema,
  effects: z.array(Effect).default([]),
  textColor: Color,
  deviceColors: z.record(z.string(), z.string()).default({}),
});
export type Style = z.infer<typeof StyleSchema>;

function loadStyles(): Record<string, Style> {
  const path = join(BUILTIN_ASSETS_DIR, "presets", "styles.json");
  const r = z.record(z.string(), StyleSchema).safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!r.success) throw schemaError(r.error.issues, "", `Preset file ${path}`);
  for (const [name, st] of Object.entries(r.data)) {
    if (!LIGHTING_PRESET_NAMES.includes(st.lighting)) throw new Error(`Style ${name} uses unknown lighting preset ${st.lighting}`);
  }
  return r.data;
}

export const STYLES: Record<string, Style> = loadStyles();
export const STYLE_NAMES = Object.keys(STYLES);

export interface ApplyStyleOptions {
  style: string;
  /** Also switch device colors to the style's suggested variants (default false). */
  recolorDevices?: boolean;
  /** Also recolor existing text nodes to the style's text color (default true). */
  recolorText?: boolean;
  /** Override the style's floor. */
  floor?: FloorSpec;
}

/** Applies background, lighting, effects and floor from a named style. */
export function applyStyle(scene: Scene, opts: ApplyStyleOptions, devices: DeviceRegistry): Scene {
  const st = STYLES[opts.style];
  if (!st) throw new DwError("UNKNOWN_STYLE", `Unknown style '${opts.style}'. Use one of: ${STYLE_NAMES.join(", ")}.`);
  let s = setBackground(scene, st.background);
  s = setLights(s, { preset: st.lighting, ...(st.lightOverrides.length ? { lights: st.lightOverrides } : {}) });
  if (st.environment) s = { ...s, environment: st.environment };
  s = setEffects(s, { effects: st.effects });
  s = setFloor(s, opts.floor ?? st.floor, devices);
  if (opts.recolorText ?? true) {
    for (const n of s.nodes) if (n.kind === "text2d") s = updateNode(s, n.id, { color: st.textColor }, devices);
  }
  if (opts.recolorDevices) {
    for (const n of s.nodes) {
      if (n.kind !== "device") continue;
      const def = devices.get(n.model);
      const want = def && st.deviceColors[def.category];
      if (want && def.colors.some((c) => c.name === want)) s = updateNode(s, n.id, { color: want }, devices);
    }
  }
  return s;
}
