import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ComposeBrief,
  DwError,
  FloorSpecSchema,
  LAYOUTS,
  LAYOUT_NAMES,
  MOTIONS,
  MOTION_NAMES,
  STYLES,
  STYLE_NAMES,
  applyLayout,
  applyMotion,
  applyStyle,
  composeScene,
  expandTemplate,
  loadTemplates,
} from "@devicewrapper/core";
import type { Engine } from "@devicewrapper/jobs";
import { Id } from "@devicewrapper/schema";
import { mutate } from "../helpers.js";
import { ok, summarizeScene, wrap } from "../result.js";
import { SceneId } from "../schemas.js";

const list = (o: Record<string, { description: string } | string>) =>
  Object.entries(o)
    .map(([k, v]) => `${k} (${typeof v === "string" ? v : v.description})`)
    .join("; ");

export function registerComposeTools(server: McpServer, engine: Engine): void {
  const templates = () => loadTemplates([engine.ws.userTemplatesDir]);

  server.registerTool(
    "compose_scene",
    {
      title: "Compose scene",
      description: [
        "Build a complete scene in one call from a declarative brief (or a template), then refine it with the other tools.",
        "Deterministic: the same brief always builds the same scene. Saved as a new scene; returns a summary.",
        "Brief fields: devices (required, 1–12: { model, color?, screen?: path or asset ID, lidAngle? }), layout, layoutOptions, style, camera { shot, focalLength, padding, shift },",
        "text [{ content, position: top|bottom|center|top-left|…, size?, weight?, color? }], variables, locales, motion (preset name, object, or list), duration, preset (canvas size), render.",
        "Text: size is in canvas pixels (scaled with the output size; default ~7% of the short side for a top headline, ~4% for a bottom line); weight 100–900. The camera leaves room for text automatically.",
        "Localization: text content may use {{variables}}; variables: { headline: 'Train smarter' }, locales: { es: { headline: 'Entrena mejor' } }; then render { locales: ['en', 'es'] }.",
        "motion: preset names as in apply_motion (e.g. 'float', 'slow-turn', 'push-in'), or objects { preset, target?, start?, duration?, amount? }; target 'all' moves the whole arrangement as one unit.",
        "duration sets the timeline length; whole-timeline motions stretch to it, entrances (rise, lid-open, …) keep their natural length.",
        `Styles: ${STYLE_NAMES.join(", ")}. Layouts: ${LAYOUT_NAMES.join(", ")} (default picked from the devices).`,
        "Templates (see list_templates) are ready-made briefs: pass template + screens, plus any brief fields to override.",
        "Example: { name: 'Fitness launch', preset: '1080p', style: 'dark-studio', devices: [{ model: 'phone-modern', screen: 'screens/workout.png' }], motion: ['slow-turn', 'push-in'], duration: 5 }",
        "Example: { template: 'phone-trio', screens: ['a.png', 'b.png', 'c.png'], style: 'mint' }",
        "Next: render_preview to look at it, then adjust (update_node, set_camera, set_lights, apply_motion …) and render.",
      ].join("\n"),
      inputSchema: {
        template: z.string().optional().describe("Template name from list_templates."),
        screens: z.array(z.string()).optional().describe("Screenshots/recordings for the template's slots, in order (paths or asset IDs)."),
        id: Id.optional().describe("Scene ID. Default: from name/template, made unique."),
        overwrite: z.boolean().default(false),
        name: z.string().max(200).optional(),
        concept: z.string().max(4000).optional(),
        preset: ComposeBrief.shape.preset,
        canvas: ComposeBrief.shape.canvas,
        duration: ComposeBrief.shape.duration,
        devices: ComposeBrief.shape.devices.optional().describe("Required unless a template is used."),
        layout: ComposeBrief.shape.layout,
        layoutOptions: ComposeBrief.shape.layoutOptions,
        style: z.enum(STYLE_NAMES as [string, ...string[]]).optional().describe("Default: light-studio (or the template's)."),
        camera: ComposeBrief.shape.camera,
        text: ComposeBrief.shape.text,
        variables: ComposeBrief.shape.variables,
        locales: ComposeBrief.shape.locales,
        motion: ComposeBrief.shape.motion,
        render: ComposeBrief.shape.render,
      },
    },
    wrap(async (a) => {
      const { template, screens, overwrite, ...fields } = a;
      const briefFields: Record<string, unknown> = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
      let brief: Record<string, unknown> = briefFields;
      if (template) {
        const tpl = templates().get(template);
        if (!tpl) throw new DwError("UNKNOWN_TEMPLATE", `No template '${template}'. Available: ${[...templates().keys()].join(", ")}.`);
        if ((screens?.length ?? 0) === 0 && tpl.screens > 0) {
          throw new DwError("MISSING_SCREENS", `Template '${template}' needs ${tpl.screens} screenshot(s) in 'screens'.`, { hint: "Pass workspace paths, e.g. screens: ['design/home.png']." });
        }
        const { variables, ...rest } = briefFields;
        brief = expandTemplate(tpl, screens ?? [], (variables as Record<string, string>) ?? {}, rest);
        if (!brief.name) brief.name = tpl.title;
      } else if (!briefFields.devices) {
        throw new DwError("MISSING_ARGUMENT", "compose_scene needs 'devices' (or a 'template').");
      }
      const id = (brief.id as string | undefined) ?? engine.store.allocateId((brief.name as string | undefined) ?? template ?? "scene");
      if (engine.store.exists(id) && !overwrite) throw new DwError("SCENE_EXISTS", `Scene '${id}' already exists.`, { hint: "Pass overwrite: true or another id." });
      const scene = await composeScene(engine.ws, engine.devices, brief, id);
      engine.store.save(scene);
      const report = engine.validate(scene);
      const issues = [...report.errors, ...report.warnings].map((i) => `${i.severity}: ${i.message}`);
      for (const n of scene.nodes) {
        if (n.kind === "device" && n.screen.source.type === "color") issues.push(`note: '${n.id}' has no screen content (shows a plain screen); set one with update_node { id: '${n.id}', screen: 'path/to/screenshot.png' }.`);
      }
      return ok({ sceneId: id, scene: summarizeScene(scene), ...(issues.length ? { issues } : {}) });
    }),
  );

  server.registerTool(
    "list_templates",
    {
      title: "List templates",
      description: "Ready-made scene briefs (built-in plus any JSON templates in .devicewrapper/templates/). Use with compose_scene { template, screens }.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    wrap(async () =>
      ok({
        templates: [...templates().values()].map((t) => ({ name: t.name, title: t.title, description: t.description, screens: t.screens, variables: t.variables, style: t.brief.style })),
      }),
    ),
  );

  server.registerTool(
    "apply_layout",
    {
      title: "Apply layout",
      description: [
        "Arrange devices (all devices by default, or `targets`) using their real sizes; they stand on a common floor line.",
        `Layouts: ${list(LAYOUTS)}.`,
        "Options: spacing (gap as a fraction of device width), angle (degrees), depth (meters), columns (grid), tilt (X tilt in degrees for all).",
        "Re-frame afterwards with set_camera { frame: { shot } }. Example: { sceneId: 'launch', layout: 'arc', angle: 18 }",
      ].join("\n"),
      inputSchema: {
        sceneId: SceneId,
        layout: z.enum(LAYOUT_NAMES as [string, ...string[]]),
        targets: z.array(Id).optional(),
        spacing: z.number().optional(),
        angle: z.number().optional(),
        depth: z.number().optional(),
        columns: z.number().int().positive().optional(),
        tilt: z.number().optional(),
      },
      annotations: { idempotentHint: true },
    },
    wrap(async (a) => {
      const res = await mutate(engine, a.sceneId, (scene) => {
        const { sceneId: _s, ...opts } = a;
        const next = applyLayout(scene, opts as never, engine.devices);
        return {
          scene: next,
          result: {
            devices: next.nodes.filter((n) => n.kind === "device").map((n) => (n.kind === "device" ? { id: n.id, position: n.transform.position, rotation: n.transform.rotation, parent: n.parent } : null)),
          },
        };
      });
      return ok(res);
    }),
  );

  server.registerTool(
    "apply_style",
    {
      title: "Apply style",
      description: [
        "Apply a complete look in one call: background, lighting preset, environment reflections, effects and a floor (soft shadow or glossy reflection), and recolor text to match.",
        `Styles: ${list(STYLES)}.`,
        "recolorDevices: true also switches devices to the style's suggested colors. Fine-tune afterwards with set_background / set_lights / set_effects.",
      ].join("\n"),
      inputSchema: {
        sceneId: SceneId,
        style: z.enum(STYLE_NAMES as [string, ...string[]]),
        recolorDevices: z.boolean().default(false),
        floor: FloorSpecSchema.optional().describe("Override the style's floor: none, shadow, solid { color }, or reflective { strength, blur }."),
      },
      annotations: { idempotentHint: true },
    },
    wrap(async (a) => {
      const res = await mutate(engine, a.sceneId, (scene) => {
        const next = applyStyle(scene, { style: a.style, recolorDevices: a.recolorDevices, ...(a.floor ? { floor: a.floor as never } : {}) }, engine.devices);
        return { scene: next, result: { style: a.style, background: next.background.type, lights: next.lights.map((l) => l.id), effects: next.effects.map((e) => e.type) } };
      });
      return ok(res);
    }),
  );

  server.registerTool(
    "apply_motion",
    {
      title: "Apply motion preset",
      description: [
        "Add a named animation relative to the current pose. Device motions target all top-level devices by default (entrances are staggered), or `target`.",
        "Text: target a text node ID or 'texts' (all text) with fade-in, fade-out, rise, drop-in, enter-left/right, exit-left/right.",
        `Presets: ${list(MOTIONS)}.`,
        "target 'all': every device moves as one unit (they are grouped under 'arrangement'); use it to turn or orbit a fan/arc/row as a whole, since without it turntable/slow-turn spin each device on its own axis.",
        "Timing: start/duration in seconds (defaults: whole timeline; entrances ~1.2 s at the start; exits at the end). amount scales the motion.",
        "Motions layer: if the property is already animated (e.g. float then rise), the device is wrapped in a group and the group is animated (stack: 'auto'; use 'replace' to overwrite).",
        "The timeline is extended if a motion ends after it. Example: { sceneId: 'hero', preset: 'orbit', amount: 40 }",
      ].join("\n"),
      inputSchema: {
        sceneId: SceneId,
        preset: z.enum(MOTION_NAMES as [string, ...string[]]),
        target: z.string().optional(),
        start: z.number().min(0).optional(),
        duration: z.number().positive().optional(),
        amount: z.number().optional(),
        easing: z.string().optional(),
        stagger: z.number().min(0).optional(),
        stack: z.enum(["auto", "replace"]).default("auto"),
      },
    },
    wrap(async (a) => {
      const res = await mutate(engine, a.sceneId, (scene) => {
        const { sceneId: _s, ...opts } = a;
        const r = applyMotion(scene, opts as never, engine.devices);
        return {
          scene: r.scene,
          result: {
            animated: r.animated,
            ...(r.wrapped.length ? { wrapped: r.wrapped } : {}),
            ...(r.durationExtended ? { durationExtendedTo: r.durationExtended } : {}),
          },
        };
      });
      return ok(res);
    }),
  );
}
