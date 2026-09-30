import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CAMERA_SHOTS, LAYOUTS, LIGHTING_PRESETS, MOTIONS, SHOT_PRESETS, STYLES, animatableCatalog, canonicalStringify, deviceSize } from "@devicewrapper/core";
import type { Engine } from "@devicewrapper/jobs";
import { EASINGS, sceneJsonSchema } from "@devicewrapper/schema";
import { GUIDE } from "./guide.js";
import { CANVAS_PRESETS } from "./schemas.js";

const json = (uri: string, data: unknown) => ({
  contents: [{ uri, mimeType: "application/json", text: JSON.stringify(data, null, 2) }],
});

export function registerResources(server: McpServer, engine: Engine): void {
  server.registerResource(
    "guide",
    "devicewrapper://guide",
    { title: "How to use devicewrapper", description: "Workflow, conventions and tips for building device mockups. Read this first.", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: GUIDE }] }),
  );

  server.registerResource(
    "scene-schema",
    "devicewrapper://schema/scene",
    { title: "Scene JSON Schema", description: "The complete scene format as JSON Schema.", mimeType: "application/schema+json" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/schema+json", text: JSON.stringify(sceneJsonSchema(), null, 2) }] }),
  );

  server.registerResource(
    "devices",
    "devicewrapper://devices",
    { title: "Device models", description: "Every device model with its size in meters, screen resolution and color variants.", mimeType: "application/json" },
    async (uri) =>
      json(
        uri.href,
        engine.devices.list().map((d) => ({
          id: d.id,
          name: d.name,
          category: d.category,
          description: d.description,
          form: d.form,
          sizeMeters: deviceSize(d).map((v) => Math.round(v * 10000) / 10000),
          screenPixels: d.screen.pixels,
          screenAspect: Math.round((d.screen.pixels[0] / d.screen.pixels[1]) * 10000) / 10000,
          colors: d.colors.map((c) => ({ name: c.name, hex: c.body, finish: c.finish })),
        })),
      ),
  );

  server.registerResource(
    "presets",
    "devicewrapper://presets",
    { title: "Presets", description: "Styles, layouts, motions, lighting presets, camera shots, easings and canvas sizes.", mimeType: "application/json" },
    async (uri) =>
      json(uri.href, {
        lighting: Object.fromEntries(Object.entries(LIGHTING_PRESETS).map(([k, v]) => [k, { description: v.description, lights: v.lights.map((l) => `${l.id} (${l.type})`) }])),
        cameraShots: Object.fromEntries(CAMERA_SHOTS.map((s) => [s, SHOT_PRESETS[s]!.description])),
        styles: Object.fromEntries(Object.entries(STYLES).map(([k, v]) => [k, v.description])),
        layouts: LAYOUTS,
        motions: Object.fromEntries(Object.entries(MOTIONS).map(([k, v]) => [k, `${v.kind}: ${v.description}`])),
        easings: EASINGS,
        canvas: CANVAS_PRESETS,
      }),
  );

  server.registerResource(
    "animatable",
    "devicewrapper://animatable",
    { title: "Animatable properties", description: "Every property set_track can animate, per target type, with value kinds and ranges.", mimeType: "application/json" },
    async (uri) => json(uri.href, animatableCatalog()),
  );

  server.registerResource(
    "capabilities",
    "devicewrapper://capabilities",
    { title: "Renderer capabilities", description: "What the attached renderer can draw right now (formats, effects, backgrounds, fonts).", mimeType: "application/json" },
    async (uri) => json(uri.href, { renderer: engine.backend?.name ?? null, ...engine.capabilities }),
  );

  server.registerResource(
    "scene",
    new ResourceTemplate("devicewrapper://scenes/{sceneId}", {
      list: async () => ({
        resources: engine.store.list().map((s) => ({
          uri: `devicewrapper://scenes/${s.id}`,
          name: s.id,
          title: s.name ?? s.id,
          mimeType: "application/json",
        })),
      }),
    }),
    { title: "Scene", description: "A saved scene as canonical JSON.", mimeType: "application/json" },
    async (uri, vars) => {
      const id = String(vars.sceneId);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: canonicalStringify(engine.store.load(id)) }] };
    },
  );
}
