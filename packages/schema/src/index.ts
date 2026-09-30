import { z } from "zod";
import { Scene } from "./scene.js";

export * from "./primitives.js";
export * from "./scene.js";
export * from "./device.js";

/** JSON Schema (draft 2020-12) for the scene format, as served to agents. */
export function sceneJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(Scene, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
}
