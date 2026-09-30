import { writeFileSync } from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DwError, LIGHTING_PRESET_NAMES, canonicalStringify, createScene, parseScene, updateScene, migrateScene } from "@devicewrapper/core";
import type { Engine } from "@devicewrapper/jobs";
import { Background, Id, Material } from "@devicewrapper/schema";
import { mutate } from "../helpers.js";
import { ok, summarizeScene, wrap } from "../result.js";
import { CANVAS_PRESETS, CanvasPatch, CanvasPreset, EnvironmentPatch, RenderPatch, SceneId } from "../schemas.js";

const LightingName = z.enum(["none", ...LIGHTING_PRESET_NAMES] as [string, ...string[]]);

function canvasFrom(preset: keyof typeof CANVAS_PRESETS | undefined, canvas: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!preset && !canvas) return undefined;
  const out: Record<string, unknown> = { ...(canvas ?? {}) };
  if (preset) {
    const [w, h] = CANVAS_PRESETS[preset];
    out.width ??= w;
    out.height ??= h;
  }
  return out;
}

export function registerSceneTools(server: McpServer, engine: Engine): void {
  server.registerTool(
    "create_scene",
    {
      title: "Create scene",
      description: [
        "Create a new, empty scene and save it. This is the first call of every workflow.",
        "The scene starts with studio lighting (change with `lighting`), a light gray background, and a camera looking at the origin.",
        "Units are meters (a phone is ~0.07 x 0.15 m) and degrees. +Y is up; the camera looks toward -Z by default.",
        "Next steps: add_device → import screenshots (add_device's `screen` accepts a file path) → set_camera { frame: { shot: 'hero' } } → render_preview.",
        "Example: { name: 'Fitness hero', preset: '1080p', lighting: 'soft-studio', background: { type: 'gradient', kind: 'radial', stops: [{ color: '#ffffff', offset: 0 }, { color: '#dfe4ee', offset: 1 }] } }",
      ].join("\n"),
      inputSchema: {
        id: Id.optional().describe("Scene ID. Default: derived from name (or 'scene'), made unique."),
        name: z.string().max(200).optional(),
        description: z.string().max(4000).optional(),
        preset: CanvasPreset.optional().describe("Canvas size preset. Explicit canvas.width/height win."),
        canvas: CanvasPatch.optional().describe("Width, height, fps (default 30), duration seconds (default 5)."),
        background: Background.optional().describe("Default: solid #f2f2f4."),
        lighting: LightingName.default("studio").describe(`Lighting preset: ${LIGHTING_PRESET_NAMES.join(", ")}, or 'none'.`),
        overwrite: z.boolean().default(false).describe("Replace an existing scene with the same ID."),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    wrap(async (a) => {
      const id = a.id ?? engine.store.allocateId(a.name ?? "scene");
      if (engine.store.exists(id) && !a.overwrite) {
        throw new DwError("SCENE_EXISTS", `Scene '${id}' already exists.`, { hint: "Pick another id, omit id to auto-assign, or pass overwrite: true." });
      }
      const canvas = canvasFrom(a.preset, a.canvas as Record<string, unknown> | undefined);
      const scene = createScene({
        id,
        ...(a.name !== undefined ? { name: a.name } : {}),
        ...(a.description !== undefined ? { description: a.description } : {}),
        ...(canvas ? { canvas } : {}),
        ...(a.background ? { background: a.background } : {}),
        lighting: a.lighting,
      });
      engine.store.save(scene);
      return ok({ sceneId: id, scene: summarizeScene(scene) });
    }),
  );

  server.registerTool(
    "list_scenes",
    {
      title: "List scenes",
      description: "List every scene saved in this workspace with its size, duration and node counts.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    wrap(async () => ok({ workspace: engine.ws.root, scenes: engine.store.list() })),
  );

  server.registerTool(
    "get_scene",
    {
      title: "Get scene",
      description: [
        "Read a scene. detail 'summary' (default) is a compact overview: nodes with positions and screens, lights, camera, tracks, assets.",
        "detail 'full' returns the complete canonical scene JSON (every field, including defaults).",
      ].join("\n"),
      inputSchema: { sceneId: SceneId, detail: z.enum(["summary", "full"]).default("summary") },
      annotations: { readOnlyHint: true },
    },
    wrap(async (a) => {
      const scene = engine.store.load(a.sceneId);
      return ok(a.detail === "full" ? { scene } : { scene: summarizeScene(scene) });
    }),
  );

  server.registerTool(
    "update_scene",
    {
      title: "Update scene settings",
      description: [
        "Change scene-level settings. Every field is optional; objects are merged (only the fields you pass change).",
        "canvas: width, height, fps, duration (seconds). environment: reflection preset (studio | soft | none), intensity, rotation.",
        "render: default output settings (format, quality, transparent, supersample, time). materials: named materials nodes can reference by ID (null deletes one).",
        "Example: { sceneId: 'hero', preset: '4k', canvas: { duration: 8, fps: 60 } }",
      ].join("\n"),
      inputSchema: {
        sceneId: SceneId,
        name: z.string().max(200).nullable().optional(),
        description: z.string().max(4000).nullable().optional(),
        seed: z.number().int().min(0).optional().describe("Seed for procedural effects such as grain."),
        preset: CanvasPreset.optional().describe("Sets canvas width and height."),
        canvas: CanvasPatch.optional(),
        environment: EnvironmentPatch.optional(),
        render: RenderPatch.optional(),
        defaultLocale: z.string().optional(),
        materials: z.record(Id, Material.nullable()).optional().describe("Named materials to add/replace (null removes)."),
      },
      annotations: { idempotentHint: true },
    },
    wrap(async (a) => {
      const res = await mutate(engine, a.sceneId, (scene) => {
        const canvas = canvasFrom(a.preset, a.canvas as Record<string, unknown> | undefined);
        const next = updateScene(scene, {
          ...(a.name !== undefined ? { name: a.name } : {}),
          ...(a.description !== undefined ? { description: a.description } : {}),
          ...(a.seed !== undefined ? { seed: a.seed } : {}),
          ...(canvas ? { canvas } : {}),
          ...(a.environment ? { environment: a.environment as Record<string, unknown> } : {}),
          ...(a.render ? { render: a.render as Record<string, unknown> } : {}),
          ...(a.defaultLocale !== undefined ? { defaultLocale: a.defaultLocale } : {}),
          ...(a.materials ? { materials: a.materials as Record<string, unknown> } : {}),
        });
        return { scene: next, result: { canvas: next.canvas, render: next.render, environment: next.environment } };
      });
      return ok(res);
    }),
  );

  server.registerTool(
    "duplicate_scene",
    {
      title: "Duplicate scene",
      description: "Copy a scene under a new ID, e.g. to try a variation without losing the original.",
      inputSchema: { sceneId: SceneId, newId: Id.optional().describe("Default: '<sceneId>-2', '-3', …"), name: z.string().max(200).optional() },
    },
    wrap(async (a) => {
      const scene = engine.store.load(a.sceneId);
      const newId = a.newId ?? engine.store.allocateId(a.sceneId);
      if (engine.store.exists(newId)) throw new DwError("SCENE_EXISTS", `Scene '${newId}' already exists.`);
      const copy = { ...structuredClone(scene), id: newId };
      if (a.name) copy.name = a.name;
      engine.store.save(copy);
      return ok({ sceneId: newId, copiedFrom: a.sceneId });
    }),
  );

  server.registerTool(
    "delete_scene",
    {
      title: "Delete scene",
      description: "Permanently delete a scene file. Rendered outputs and imported source files are not touched.",
      inputSchema: { sceneId: SceneId },
      annotations: { destructiveHint: true },
    },
    wrap(async (a) => {
      engine.store.delete(a.sceneId);
      return ok({ deleted: a.sceneId });
    }),
  );

  server.registerTool(
    "validate_scene",
    {
      title: "Validate scene",
      description: [
        "Check a saved scene (sceneId) or raw scene JSON (scene) for problems before rendering:",
        "missing assets or files, unknown devices/colors/materials, bad parents, invalid animation targets/properties/values,",
        "undefined text variables, unsupported formats, and features the current renderer cannot draw yet.",
        "Returns { valid, errors[], warnings[] }; each issue has code, message, path and often a hint.",
      ].join("\n"),
      inputSchema: {
        sceneId: SceneId.optional(),
        scene: z.record(z.string(), z.unknown()).optional().describe("Raw scene JSON to check instead of a saved scene."),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(async (a) => {
      if (!a.sceneId && !a.scene) throw new DwError("MISSING_ARGUMENT", "Pass sceneId or scene.");
      const input = a.scene ?? engine.store.load(a.sceneId!);
      return ok({ ...engine.validate(input) });
    }),
  );

  server.registerTool(
    "import_scene",
    {
      title: "Import scene JSON",
      description: "Save raw scene JSON (for example from export_scene, a template, or another project) as a scene in this workspace. The JSON is validated and upgraded to the current schema version.",
      inputSchema: {
        scene: z.record(z.string(), z.unknown()).describe("Scene JSON. Its 'id' is used unless you pass id."),
        id: Id.optional(),
        overwrite: z.boolean().default(false),
      },
    },
    wrap(async (a) => {
      const raw = migrateScene({ ...a.scene, ...(a.id ? { id: a.id } : {}) }) as Record<string, unknown>;
      if (typeof raw.id !== "string") raw.id = engine.store.allocateId(typeof raw.name === "string" ? raw.name : "scene");
      const scene = parseScene(raw);
      if (engine.store.exists(scene.id) && !a.overwrite) {
        throw new DwError("SCENE_EXISTS", `Scene '${scene.id}' already exists.`, { hint: "Pass overwrite: true or a different id." });
      }
      engine.store.save(scene);
      const report = engine.validate(scene);
      return ok({ sceneId: scene.id, valid: report.valid, errors: report.errors, warnings: report.warnings });
    }),
  );

  server.registerTool(
    "export_scene",
    {
      title: "Export scene JSON",
      description: "Return a scene as canonical JSON (sorted keys, all defaults filled). Optionally also write it to a workspace path. Identical scenes always export byte-identically.",
      inputSchema: { sceneId: SceneId, path: z.string().optional().describe("Workspace-relative .json path to write.") },
      annotations: { readOnlyHint: false },
    },
    wrap(async (a) => {
      const scene = engine.store.load(a.sceneId);
      let written: string | undefined;
      if (a.path) {
        const abs = engine.ws.resolveWrite(a.path, "Export");
        writeFileSync(abs, canonicalStringify(scene));
        written = engine.ws.display(abs);
      }
      return ok({ ...(written ? { path: written } : {}), scene });
    }),
  );
}
