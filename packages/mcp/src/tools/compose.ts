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
  applyMotionClip,
  composeScene,
  expandTemplate,
  instantiateSceneTemplate,
  loadTemplates,
  sceneToMotionClip,
  sceneToTemplate,
  writeTemplate,
  type TemplateFile,
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
  const templates = () =>
    loadTemplates([
      { dir: engine.ws.globalTemplatesDir, scope: "global" },
      { dir: engine.ws.userTemplatesDir, scope: "project" },
    ]);
  const findTemplate = (name: string) => {
    const all = templates();
    const tpl = all.get(name);
    if (!tpl) throw new DwError("UNKNOWN_TEMPLATE", `No template '${name}'. Available: ${[...all.keys()].join(", ")}.`, { hint: "list_templates shows every template with its kind." });
    return tpl;
  };

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
        "Templates (see list_templates): pass template + screens (filled into the {{screenN}} slots in order) + variables. Brief templates also take any brief field as an override;",
        "scene templates (saved with save_template) replay a whole composition — keyframes, camera, look — and take only name, preset, canvas, duration, render, style, variables, locales.",
        "Motion templates are single movements: play them with apply_motion { clip }.",
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
        const tpl = findTemplate(template);
        if (tpl.kind === "motion") {
          throw new DwError("WRONG_TEMPLATE_KIND", `'${template}' is a motion clip, not a scene.`, { hint: `Play it on an existing scene: apply_motion { sceneId, clip: '${template}', start }.` });
        }
        if ((screens?.length ?? 0) === 0 && tpl.screens > 0) {
          throw new DwError("MISSING_SCREENS", `Template '${template}' needs ${tpl.screens} screenshot(s) in 'screens'.`, { hint: "Pass workspace paths, e.g. screens: ['design/home.png']." });
        }
        if (tpl.kind === "scene") {
          const { id: wantId, ...overrides } = briefFields;
          const id = (wantId as string | undefined) ?? engine.store.allocateId((overrides.name as string | undefined) ?? template);
          if (engine.store.exists(id) && !overwrite) throw new DwError("SCENE_EXISTS", `Scene '${id}' already exists.`, { hint: "Pass overwrite: true or another id." });
          const scene = await instantiateSceneTemplate(engine.ws, engine.devices, tpl, screens ?? [], id, overrides);
          engine.store.save(scene);
          const report = engine.validate(scene);
          const issues = [...report.errors, ...report.warnings].map((i) => `${i.severity}: ${i.message}`);
          return ok({ sceneId: id, template: { name: tpl.name, kind: tpl.kind, scope: tpl.scope }, scene: summarizeScene(scene), ...(issues.length ? { issues } : {}) });
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
      description: [
        "Every reusable composition: built-in briefs, global templates (shared by all projects) and project templates (.devicewrapper/templates/); a project template overrides a global one of the same name.",
        "kind 'brief' / 'scene': compose_scene { template, screens, variables }. kind 'motion': a single movement, played with apply_motion { clip, start }.",
        "Save new ones from a scene you like with save_template.",
      ].join("\n"),
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    wrap(async () =>
      ok({
        folders: { global: engine.ws.globalTemplatesDir, project: engine.ws.userTemplatesDir },
        templates: [...templates().values()].map((t) => ({
          name: t.name,
          kind: t.kind,
          scope: t.scope,
          title: t.title,
          description: t.description,
          screens: t.screens,
          variables: t.variables,
          ...(t.brief?.style ? { style: t.brief.style } : {}),
          ...(t.motion ? { duration: t.motion.duration } : {}),
        })),
      }),
    ),
  );

  server.registerTool(
    "save_template",
    {
      title: "Save template",
      description: [
        "Save a composition the user liked so it can be reused, in this project or (scope 'global') in every project.",
        "kind 'scene' (default): the whole scene — devices, look, camera, every keyframe. Each device screen becomes a {{screenN}} slot and each text a {{variable}} (named after the text node),",
        "so compose_scene { template, screens, variables } replays the same motion on another project's screenshots.",
        "kind 'motion': one movement — the camera, one device and the text tracks over range [start, end] — stored relative to the device and its screen size; play it with apply_motion { clip, start }.",
        "Before saving, show the user what will be saved and get a yes: never save without being asked to.",
        "Example: { sceneId: 'reel-home', name: 'punch-in-top', kind: 'motion', range: [0.75, 1.5], scope: 'global', description: 'Slams in to the top third of the screen' }",
      ].join("\n"),
      inputSchema: {
        sceneId: SceneId,
        name: Id.describe("Template name (letters, digits, '-', '_'); the file is <name>.json."),
        title: z.string().max(200).optional(),
        description: z.string().max(2000).optional(),
        kind: z.enum(["scene", "motion"]).default("scene"),
        scope: z.enum(["project", "global"]).default("project").describe("project: .devicewrapper/templates in this workspace. global: shared by every workspace."),
        range: z.tuple([z.number().min(0), z.number().positive()]).optional().describe("motion: [start, end] seconds. Default: the whole timeline."),
        target: Id.optional().describe("motion: the device the movement is about. Default: the scene's only device."),
        includeCamera: z.boolean().default(true).describe("motion: include the camera (its framing is saved even when it doesn't move)."),
        includeText: z.boolean().default(true).describe("motion: include text tracks (replayed on the target scene's text nodes, in order)."),
        textVariables: z.boolean().default(true).describe("scene: turn each text into a {{variable}} so it can be replaced per project."),
        overwrite: z.boolean().default(false),
      },
    },
    wrap(async (a) => {
      const scene = engine.store.load(a.sceneId);
      let template: TemplateFile;
      let warnings: string[];
      if (a.kind === "motion") {
        const r = sceneToMotionClip(scene, engine.devices, {
          ...(a.range ? { range: a.range } : {}),
          ...(a.target ? { target: a.target } : {}),
          includeCamera: a.includeCamera,
          includeText: a.includeText,
        });
        const range = a.range ?? [0, scene.canvas.duration];
        template = { name: a.name, title: a.title ?? a.name, description: a.description ?? `Movement from scene '${scene.id}', ${range[0]}–${range[1]} s.`, screens: 0, variables: [], motion: r.clip };
        warnings = r.warnings;
      } else {
        const r = sceneToTemplate(scene, { name: a.name, ...(a.title ? { title: a.title } : {}), ...(a.description ? { description: a.description } : {}), textVariables: a.textVariables });
        template = r.template;
        warnings = r.warnings;
      }
      const dir = a.scope === "global" ? engine.ws.globalTemplatesDir : engine.ws.userTemplatesDir;
      const path = writeTemplate(dir, template, a.overwrite);
      const saved = templates().get(a.name)!;
      return ok({
        template: { name: a.name, kind: saved.kind, scope: a.scope, path, screens: template.screens, variables: template.variables, ...(template.motion ? { duration: template.motion.duration, tracks: template.motion.tracks.map((t) => `${t.role}.${t.property}`) } : {}) },
        ...(saved.scope !== a.scope ? { note: `A ${saved.scope} template named '${a.name}' takes precedence over this one.` } : {}),
        ...(warnings.length ? { warnings } : {}),
        next: template.motion ? `apply_motion { sceneId, clip: '${a.name}', start }` : `compose_scene { template: '${a.name}', screens: [...] , variables: {...} }`,
      });
    }),
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
        "Or play a saved movement: { clip: '<motion template>', start, target? } (see list_templates, kind 'motion'); it replaces only its own time window, so clips chain on one timeline.",
        "focus / reframe make punchy camera moves that fit any screenshot: focus { target: 'phone', point: [0.5, 0.3], amount: 0.4, start: 0.75, hold: 0.4 } rushes in to that spot of the display; reframe { start: 1.5, hold: 1 } pulls back out (to the base camera, or a shot).",
        "Text: target a text node ID or 'texts' (all text) with fade-in, fade-out, rise, drop-in, enter-left/right, exit-left/right.",
        `Presets: ${list(MOTIONS)}.`,
        "target 'all': every device moves as one unit (they are grouped under 'arrangement'); use it to turn or orbit a fan/arc/row as a whole, since without it turntable/slow-turn spin each device on its own axis.",
        "Timing: start/duration in seconds (defaults: whole timeline; entrances ~1.2 s at the start; exits at the end). amount scales the motion.",
        "Motions layer: if the property is already animated (e.g. float then rise), the device is wrapped in a group and the group is animated (stack: 'auto'; use 'replace' to overwrite).",
        "The timeline is extended if a motion ends after it. Example: { sceneId: 'hero', preset: 'orbit', amount: 40 }",
      ].join("\n"),
      inputSchema: {
        sceneId: SceneId,
        preset: z.enum(MOTION_NAMES as [string, ...string[]]).optional().describe("A motion preset, or use clip."),
        clip: Id.optional().describe("A saved motion template (list_templates, kind 'motion') instead of a preset."),
        target: z.string().optional(),
        start: z.number().min(0).optional(),
        duration: z.number().positive().optional(),
        amount: z.number().optional(),
        easing: z.string().optional(),
        stagger: z.number().min(0).optional(),
        stack: z.enum(["auto", "replace"]).default("auto"),
        point: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).optional().describe("focus: [x, y] on the display, 0..1 from the top-left."),
        angle: z.tuple([z.number(), z.number()]).optional().describe("focus: [yaw, pitch] degrees off the screen normal (default [8, 4])."),
        hold: z.number().min(0).optional().describe("focus / reframe: seconds to hold after arriving, with a slow drift."),
        drift: z.number().min(-1).max(1).optional().describe("focus / reframe: how far the camera keeps moving during the hold (fraction of its distance)."),
        shot: z.string().optional().describe("reframe: auto-frame with this shot instead of returning to the base camera."),
        padding: z.number().optional().describe("reframe: framing padding."),
        shift: z.tuple([z.number(), z.number()]).optional().describe("reframe: [x, y] subject shift in the frame."),
      },
    },
    wrap(async (a) => {
      if (!!a.preset === !!a.clip) throw new DwError("MISSING_ARGUMENT", "Pass either preset or clip.");
      if (a.clip) {
        const tpl = findTemplate(a.clip);
        if (!tpl.motion) throw new DwError("WRONG_TEMPLATE_KIND", `'${a.clip}' is a ${tpl.kind} template, not a motion clip.`, { hint: `Use compose_scene { template: '${a.clip}' } for it.` });
        const clip = tpl.motion;
        const res = await mutate(engine, a.sceneId, (scene) => {
          const r = applyMotionClip(scene, clip, engine.devices, { ...(a.target ? { target: a.target } : {}), ...(a.start !== undefined ? { start: a.start } : {}) });
          return {
            scene: r.scene,
            result: {
              clip: a.clip,
              animated: r.animated,
              ...(r.skipped.length ? { skipped: r.skipped } : {}),
              ...(r.durationExtended ? { durationExtendedTo: r.durationExtended } : {}),
            },
          };
        });
        return ok(res);
      }
      const res = await mutate(engine, a.sceneId, (scene) => {
        const { sceneId: _s, clip: _c, ...opts } = a;
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
