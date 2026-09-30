import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DwError, ensureAsset, removeTrack, setTrack, setVariables, updateNode, setBackground } from "@devicewrapper/core";
import type { Engine } from "@devicewrapper/jobs";
import { EASINGS, Id, Keyframe } from "@devicewrapper/schema";
import { mutate } from "../helpers.js";
import { ok, wrap } from "../result.js";
import { NodeId, SceneId } from "../schemas.js";

export function registerAnimationTools(server: McpServer, engine: Engine): void {
  server.registerTool(
    "set_track",
    {
      title: "Set animation track",
      description: [
        "Animate one property of one target with keyframes. target is a node ID, a light ID, or 'camera'.",
        "Animatable: nodes: position, rotation, scale, opacity, visible (+ devices: screen.brightness, screen.glare; text2d: anchor, size, color, rotation, opacity);",
        "camera: position, target, fov, roll, dof.focusDistance, dof.aperture; lights: intensity, color, position, target (+ spot: angle, penumbra). Full table: devicewrapper://animatable.",
        "Keyframes: { t: seconds, value, easing? }. `easing` shapes the segment from that keyframe to the next.",
        `Easings: ${EASINGS.join(", ")}, or { cubicBezier: [x1, y1, x2, y2] }. Default 'linear'; use 'easeInOut' or 'easeInOutCubic' for natural product motion.`,
        "Rotation lerps Euler degrees, so [0,0,0] → [0,360,0] is a full turntable spin. Camera position/target with 3+ keyframes follow a smooth spline.",
        "mode 'replace' (default) replaces the track; 'merge' upserts keyframes by time. Keyframes after canvas.duration are never reached (extend it with update_scene).",
        "Example (slow turn): { sceneId: 'hero', target: 'phone', property: 'rotation', keyframes: [{ t: 0, value: [0, -25, 0], easing: 'easeInOut' }, { t: 5, value: [0, 20, 0] }] }",
        "Example (camera push-in): { sceneId: 'hero', target: 'camera', property: 'fov', keyframes: [{ t: 0, value: 32, easing: 'easeOutCubic' }, { t: 5, value: 26 }] }",
      ].join("\n"),
      inputSchema: {
        sceneId: SceneId,
        target: z.string().min(1).describe("Node ID, light ID, or 'camera'."),
        property: z.string().min(1),
        keyframes: z.array(Keyframe).min(1),
        interpolation: z.enum(["auto", "linear", "spline", "slerp"]).optional(),
        mode: z.enum(["replace", "merge"]).default("replace"),
      },
      annotations: { idempotentHint: true },
    },
    wrap(async (a) => {
      const res = await mutate(engine, a.sceneId, (scene) => {
        const next = setTrack(scene, {
          target: a.target,
          property: a.property,
          keyframes: a.keyframes as Array<Record<string, unknown>>,
          ...(a.interpolation ? { interpolation: a.interpolation } : {}),
          mode: a.mode,
        });
        const track = next.animation.tracks.find((t) => t.target === a.target && t.property === a.property)!;
        return { scene: next, result: { track, duration: next.canvas.duration } };
      });
      return ok(res);
    }),
  );

  server.registerTool(
    "remove_track",
    {
      title: "Remove animation track",
      description: "Delete the animation of one property of a target, or every track of that target when property is omitted.",
      inputSchema: { sceneId: SceneId, target: z.string().min(1), property: z.string().optional() },
      annotations: { destructiveHint: true },
    },
    wrap(async (a) => {
      const res = await mutate(engine, a.sceneId, (scene) => {
        const r = removeTrack(scene, a.target, a.property);
        return { scene: r.scene, result: { removed: r.removed } };
      });
      return ok(res);
    }),
  );

  server.registerTool(
    "import_asset",
    {
      title: "Import asset",
      description: [
        "Register a file from the workspace as a scene asset: images (PNG, JPEG, WebP, SVG), videos (MP4, MOV, WebM), fonts (TTF, OTF, WOFF, WOFF2).",
        "The file is referenced in place (not copied), identified by its content, and probed for size/duration. Paths are relative to the workspace root.",
        "Optionally apply it right away: screenOf sets it as a device's screen, asBackground makes it the background.",
        "(add_device, update_node and set_background also accept file paths directly, so this tool is mainly for naming assets or reusing one file in several places.)",
        "Example: { sceneId: 'hero', path: 'marketing/screens/home.png', id: 'home', screenOf: 'phone' }",
      ].join("\n"),
      inputSchema: {
        sceneId: SceneId,
        path: z.string().min(1).describe("Workspace-relative path (or absolute path inside an allowed root)."),
        id: Id.optional().describe("Asset ID. Default: the file name without extension."),
        type: z.enum(["image", "video", "font"]).optional().describe("Expected type; import fails if the file is something else."),
        screenOf: NodeId.optional().describe("Device node whose screen should show this asset."),
        asBackground: z.boolean().default(false),
      },
    },
    wrap(async (a) => {
      const res = await mutate(engine, a.sceneId, async (scene) => {
        const r = await ensureAsset(engine.ws, scene, a.path, a.type, a.id);
        let s = r.scene;
        const asset = s.assets[r.assetId]!;
        const applied: string[] = [];
        if (a.screenOf) {
          if (asset.type !== "image" && asset.type !== "video") throw new DwError("ASSET_TYPE_MISMATCH", `A ${asset.type} cannot be a screen.`);
          s = updateNode(s, a.screenOf, { screen: { source: { type: asset.type, asset: r.assetId } } }, engine.devices);
          applied.push(`screen of '${a.screenOf}'`);
        }
        if (a.asBackground) {
          if (asset.type !== "image" && asset.type !== "video") throw new DwError("ASSET_TYPE_MISMATCH", `A ${asset.type} cannot be a background.`);
          s = setBackground(s, { type: asset.type, asset: r.assetId });
          applied.push("background");
        }
        return { scene: s, result: { assetId: r.assetId, asset, reused: r.imported === null, ...(applied.length ? { appliedTo: applied } : {}) } };
      });
      return ok(res);
    }),
  );

  server.registerTool(
    "set_variables",
    {
      title: "Set text variables / translations",
      description: [
        "Set values for {{placeholders}} used in text2d nodes. Without `locale` you set the base values; with `locale` you set that language's overrides.",
        "Rendering with locales: ['en', 'es', 'ja'] (see render) produces one output per language. {{locale}} is always available.",
        "null removes a variable. removeLocale deletes a whole language.",
        "Example: { sceneId: 'hero', variables: { headline: 'Train smarter' } } then { sceneId: 'hero', locale: 'es', variables: { headline: 'Entrena mejor' } }",
      ].join("\n"),
      inputSchema: {
        sceneId: SceneId,
        variables: z.record(z.string(), z.string().nullable()).optional(),
        locale: z.string().optional().describe("Locale code such as es, fr, de, ja, pt-BR."),
        defaultLocale: z.string().optional(),
        removeLocale: z.string().optional(),
      },
      annotations: { idempotentHint: true },
    },
    wrap(async (a) => {
      const res = await mutate(engine, a.sceneId, (scene) => {
        const next = setVariables(scene, {
          ...(a.variables ? { variables: a.variables } : {}),
          ...(a.locale ? { locale: a.locale } : {}),
          ...(a.defaultLocale ? { defaultLocale: a.defaultLocale } : {}),
          ...(a.removeLocale ? { removeLocale: a.removeLocale } : {}),
        });
        return { scene: next, result: { variables: next.variables, locales: next.locales, defaultLocale: next.defaultLocale } };
      });
      return ok(res);
    }),
  );
}
