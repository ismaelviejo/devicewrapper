import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CAMERA_SHOTS,
  LIGHTING_PRESETS,
  LIGHTING_PRESET_NAMES,
  SHOT_PRESETS,
  ensureAsset,
  setBackground,
  setCamera,
  setEffects,
  setLights,
} from "@devicewrapper/core";
import type { Engine } from "@devicewrapper/jobs";
import { Background, Effect, Id, Vec3 } from "@devicewrapper/schema";
import { mutate, round3 } from "../helpers.js";
import { ok, wrap } from "../result.js";
import { EffectPatch, LightPatch, SceneId } from "../schemas.js";

export function registerLookTools(server: McpServer, engine: Engine): void {
  server.registerTool(
    "set_camera",
    {
      title: "Set camera",
      description: [
        "Position and aim the scene camera. Two ways, combinable:",
        "1) Auto-frame (recommended): frame: { shot, targets?, padding? } computes position/target so the targets fill the frame.",
        `   Shots: ${CAMERA_SHOTS.map((s) => `${s} (${SHOT_PRESETS[s]!.description})`).join("; ")}.`,
        "   targets defaults to every device. padding is the margin as a fraction of the frame (0.15 = 15%; negative crops in).",
        "2) Manual: position, target (look-at point), fov (vertical degrees) or focalLength (mm, 35mm-equivalent), roll.",
        "Lens choice changes perspective: 50–85 mm is flattering for products; 24–35 mm is dramatic. When both are given, fov/focalLength apply first, then framing.",
        "Example: { sceneId: 'hero', focalLength: 70, frame: { shot: 'hero', padding: 0.2 } }",
      ].join("\n"),
      inputSchema: {
        sceneId: SceneId,
        type: z.enum(["perspective", "orthographic"]).optional(),
        position: Vec3.optional(),
        target: Vec3.optional(),
        fov: z.number().min(1).max(150).optional().describe("Vertical field of view, degrees."),
        focalLength: z.number().positive().optional().describe("35mm-equivalent focal length in mm (overrides fov)."),
        roll: z.number().optional().describe("Degrees."),
        orthoHeight: z.number().positive().optional().describe("Orthographic visible height, meters."),
        near: z.number().positive().optional(),
        far: z.number().positive().optional(),
        dof: z
          .object({ enabled: z.boolean().optional(), focusDistance: z.number().positive().nullable().optional(), aperture: z.number().min(0).max(1).optional() })
          .optional()
          .describe("Depth of field. focusDistance null = focus on the target."),
        frame: z
          .object({
            shot: z.enum(CAMERA_SHOTS as [string, ...string[]]).default("hero"),
            targets: z.array(Id).optional().describe("Node IDs to frame. Default: all devices."),
            direction: Vec3.optional().describe("Custom direction from subject to camera; overrides the shot's direction."),
            padding: z.number().min(-0.9).max(5).optional(),
          })
          .optional(),
      },
      annotations: { idempotentHint: true },
    },
    wrap(async (a) => {
      const res = await mutate(engine, a.sceneId, (scene) => {
        const patch: Record<string, unknown> = {};
        for (const k of ["type", "position", "target", "fov", "roll", "orthoHeight", "near", "far"] as const) {
          if (a[k] !== undefined) patch[k] = a[k];
        }
        if (a.dof) patch.dof = a.dof;
        const next = setCamera(
          scene,
          {
            patch,
            ...(a.focalLength !== undefined ? { focalLength: a.focalLength } : {}),
            ...(a.frame
              ? {
                  frame: {
                    shot: a.frame.shot,
                    ...(a.frame.targets ? { targets: a.frame.targets } : {}),
                    ...(a.frame.direction ? { direction: a.frame.direction } : {}),
                    ...(a.frame.padding !== undefined ? { padding: a.frame.padding } : {}),
                  },
                }
              : {}),
          },
          engine.devices,
        );
        const c = next.camera;
        return {
          scene: next,
          result: { camera: { type: c.type, position: round3(c.position), target: round3(c.target), fov: Math.round(c.fov * 100) / 100, roll: c.roll, dof: c.dof } },
        };
      });
      return ok(res);
    }),
  );

  server.registerTool(
    "set_lights",
    {
      title: "Set lights",
      description: [
        "Apply a lighting preset and/or add, change or remove individual lights.",
        `Presets: ${LIGHTING_PRESET_NAMES.map((n) => `${n} (${LIGHTING_PRESETS[n]!.description})`).join("; ")}.`,
        "A preset replaces all lights and the environment (reflections); keepEnvironment: true keeps the current environment.",
        "Preset light IDs are stable (key, fill, rim, ambient), so you can refine afterwards: { lights: [{ id: 'key', intensity: 3 }] }.",
        "lights (mode 'merge', default) patches lights by ID; a new ID creates a light and needs a `type`. mode 'replace' replaces the whole list.",
        "Types: ambient, hemisphere, directional (sun-like, casts shadows), point, spot. Positions are meters; directional/spot aim from position to target.",
        "Example: { sceneId: 'hero', preset: 'dark', lights: [{ id: 'rim', color: '#ff7ad9', intensity: 2.5 }] }",
      ].join("\n"),
      inputSchema: {
        sceneId: SceneId,
        preset: z.enum(LIGHTING_PRESET_NAMES as [string, ...string[]]).optional(),
        keepEnvironment: z.boolean().default(false),
        mode: z.enum(["merge", "replace"]).default("merge"),
        lights: z.array(LightPatch).optional(),
        remove: z.array(Id).optional().describe("Light IDs to delete."),
      },
    },
    wrap(async (a) => {
      const res = await mutate(engine, a.sceneId, (scene) => {
        const next = setLights(scene, {
          ...(a.preset ? { preset: a.preset } : {}),
          keepEnvironment: a.keepEnvironment,
          mode: a.mode,
          ...(a.lights ? { lights: a.lights as Array<Record<string, unknown>> } : {}),
          ...(a.remove ? { remove: a.remove } : {}),
        });
        return {
          scene: next,
          result: { lights: next.lights.map((l) => ({ id: l.id, type: l.type, intensity: l.intensity, color: l.color })), environment: next.environment },
        };
      });
      return ok(res);
    }),
  );

  server.registerTool(
    "set_background",
    {
      title: "Set background",
      description: [
        "Set what is drawn behind the 3D scene. One of:",
        "- { type: 'solid', color: '#0b0b0f' }",
        "- { type: 'gradient', kind: 'linear', angle: 180, stops: [{ color: '#1a1f3a', offset: 0 }, { color: '#05060a', offset: 1 }] }  (angle 180 = top→bottom)",
        "- { type: 'gradient', kind: 'radial', center: [0.5, 0.45], radius: 0.8, stops: [...] }",
        "- { type: 'image', asset: 'bg' | 'path/to/bg.jpg', fit: 'cover' }  (a file path is imported automatically)",
        "- { type: 'transparent' }  (PNG/WebP stills with alpha; pair with a shadowCatcher floor for a soft shadow)",
        "Backgrounds are not lit and don't receive shadows. For a visible floor or wall, add a plane with add_node.",
      ].join("\n"),
      inputSchema: { sceneId: SceneId, background: Background },
      annotations: { idempotentHint: true },
    },
    wrap(async (a) => {
      const res = await mutate(engine, a.sceneId, async (scene) => {
        let s = scene;
        const bg = { ...a.background } as Record<string, unknown>;
        let imported: string | undefined;
        if ((bg.type === "image" || bg.type === "video") && typeof bg.asset === "string") {
          const r = await ensureAsset(engine.ws, s, bg.asset, bg.type);
          s = r.scene;
          bg.asset = r.assetId;
          if (r.imported) imported = r.assetId;
        }
        const next = setBackground(s, bg);
        return { scene: next, result: { background: next.background, ...(imported ? { importedAsset: imported } : {}) } };
      });
      return ok(res);
    }),
  );

  server.registerTool(
    "set_effects",
    {
      title: "Set effects",
      description: [
        "Post-processing effects (one of each type):",
        "- vignette { strength 0..1, color }: darkens edges, focuses attention.",
        "- bloom { strength, threshold 0..1, radius 0..1 }: glow around bright areas (bright screens, rims).",
        "- fog { color, near, far } (meters from camera): depth haze; match the background color.",
        "- grain { amount 0..1 }: subtle film grain, deterministic per frame.",
        "effects replaces the whole list; upsert adds or patches effects by type; remove deletes by type.",
        "Example: { sceneId: 'hero', upsert: [{ type: 'vignette', strength: 0.3 }, { type: 'bloom', strength: 0.35 }] }",
      ].join("\n"),
      inputSchema: {
        sceneId: SceneId,
        effects: z.array(Effect).optional(),
        upsert: z.array(EffectPatch).optional(),
        remove: z.array(z.enum(["vignette", "bloom", "fog", "grain"])).optional(),
      },
      annotations: { idempotentHint: true },
    },
    wrap(async (a) => {
      const res = await mutate(engine, a.sceneId, (scene) => {
        const next = setEffects(scene, {
          ...(a.effects ? { effects: a.effects } : {}),
          ...(a.upsert ? { upsert: a.upsert } : {}),
          ...(a.remove ? { remove: a.remove } : {}),
        });
        return { scene: next, result: { effects: next.effects } };
      });
      return ok(res);
    }),
  );
}
