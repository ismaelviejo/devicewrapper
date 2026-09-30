import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Environment, Light, Vec3, type Environment as EnvironmentT, type Light as LightT } from "@devicewrapper/schema";
import { z } from "zod";
import { BUILTIN_ASSETS_DIR } from "./devices.js";
import { schemaError } from "./errors.js";

/** Presets are data (packages/core/assets/presets/*.json), loaded and validated once. */

const LightingPresetSchema = z.object({
  description: z.string(),
  environment: Environment,
  lights: z.array(Light),
});
export type LightingPreset = z.infer<typeof LightingPresetSchema>;

const ShotPresetSchema = z.object({ direction: Vec3, padding: z.number(), description: z.string() });
export type ShotPreset = z.infer<typeof ShotPresetSchema>;

function loadJson<S extends z.ZodType>(file: string, schema: S): z.infer<S> {
  const path = join(BUILTIN_ASSETS_DIR, "presets", file);
  const r = schema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!r.success) throw schemaError(r.error.issues, "", `Preset file ${path}`);
  return r.data;
}

export const LIGHTING_PRESETS: Record<string, LightingPreset> = loadJson("lighting.json", z.record(z.string(), LightingPresetSchema));
export type LightingPresetName = string;
export const LIGHTING_PRESET_NAMES = Object.keys(LIGHTING_PRESETS);

export const SHOT_PRESETS: Record<string, ShotPreset> = loadJson("shots.json", z.record(z.string(), ShotPresetSchema));
export const CAMERA_SHOTS = Object.keys(SHOT_PRESETS);
export type CameraShot = string;

export function lightingPreset(name: LightingPresetName): { environment: EnvironmentT; lights: LightT[] } {
  const p = LIGHTING_PRESETS[name];
  if (!p) throw new Error(`Unknown lighting preset ${name}`);
  return structuredClone({ environment: p.environment, lights: p.lights });
}
