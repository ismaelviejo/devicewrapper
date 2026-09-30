import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "@devicewrapper/mcp";
import type { Engine } from "@devicewrapper/jobs";
import { makeEngine, tmpWorkspace, writeScreenshot } from "../helpers.js";

let root: string;
let cleanup: () => void;
let engine: Engine;
let client: Client;

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")?.text ?? "{}";
  return { isError: r.isError === true, data: JSON.parse(text) as Record<string, any>, raw: r };
}

beforeEach(async () => {
  ({ root, cleanup } = tmpWorkspace());
  engine = makeEngine(root);
  const server = createMcpServer(engine);
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
});

afterEach(async () => {
  await client.close();
  cleanup();
});

describe("MCP surface", () => {
  it("exposes the planned tools with descriptions and schemas", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toMatchInlineSnapshot(`
      [
        "add_device",
        "add_node",
        "cancel_render_job",
        "create_scene",
        "delete_scene",
        "duplicate_scene",
        "export_scene",
        "get_render_job",
        "get_scene",
        "import_asset",
        "import_scene",
        "list_render_jobs",
        "list_scenes",
        "remove_node",
        "remove_track",
        "render",
        "render_preview",
        "set_background",
        "set_camera",
        "set_effects",
        "set_lights",
        "set_track",
        "set_variables",
        "update_node",
        "update_scene",
        "validate_scene",
      ]
    `);
    for (const t of tools) {
      expect(t.description!.length, t.name).toBeGreaterThan(40);
      expect(t.inputSchema.type).toBe("object");
    }
  });

  it("lists resources including the guide and schema", async () => {
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    for (const u of ["devicewrapper://guide", "devicewrapper://schema/scene", "devicewrapper://devices", "devicewrapper://presets", "devicewrapper://animatable"]) {
      expect(uris).toContain(u);
    }
    const devicesRes = await client.readResource({ uri: "devicewrapper://devices" });
    const list = JSON.parse((devicesRes.contents[0] as { text: string }).text);
    expect(list.map((d: { id: string }) => d.id)).toContain("phone-modern");
  });
});

describe("MCP workflow", () => {
  it("builds a scene end to end through tools", async () => {
    await writeScreenshot(join(root, "screens/home.png"), 590, 1278);

    const created = await call("create_scene", { name: "Fitness Hero", preset: "1080p", lighting: "soft-studio" });
    expect(created.isError).toBe(false);
    const sceneId = created.data.sceneId;
    expect(sceneId).toBe("fitness-hero");

    const dev = await call("add_device", { sceneId, model: "phone-modern", color: "black", screen: "screens/home.png", rotation: [0, -18, 0] });
    expect(dev.isError).toBe(false);
    expect(dev.data).toMatchObject({ nodeId: "phone", importedAsset: "home" });

    const cam = await call("set_camera", { sceneId, focalLength: 70, frame: { shot: "hero" } });
    expect(cam.data.camera.fov).toBeCloseTo(19.46, 1);

    expect((await call("set_background", { sceneId, background: { type: "gradient", kind: "radial", stops: [{ color: "#ffffff", offset: 0 }, { color: "#dfe4ee", offset: 1 }] } })).isError).toBe(false);
    expect((await call("set_lights", { sceneId, preset: "product", lights: [{ id: "key", intensity: 2.4 }] })).data.lights[0]).toMatchObject({ id: "key", intensity: 2.4 });
    expect((await call("add_node", { sceneId, node: { kind: "plane", transform: { position: [0, -0.09, 0] }, material: { type: "shadowCatcher" } } })).data.nodeId).toBe("plane");
    expect((await call("set_track", { sceneId, target: "phone", property: "rotation", keyframes: [{ t: 0, value: [0, -18, 0], easing: "easeInOut" }, { t: 5, value: [0, 18, 0] }] })).isError).toBe(false);
    expect((await call("set_effects", { sceneId, upsert: [{ type: "vignette", strength: 0.25 }] })).isError).toBe(false);
    expect((await call("add_node", { sceneId, node: { kind: "text2d", content: "{{headline}}" } })).data.nodeId).toBe("text");
    expect((await call("set_variables", { sceneId, variables: { headline: "Train smarter" } })).isError).toBe(false);
    expect((await call("set_variables", { sceneId, locale: "es", variables: { headline: "Entrena mejor" } })).isError).toBe(false);
    expect((await call("update_node", { sceneId, id: "phone", patch: { screen: { glare: 0.1 } } })).data.node.screen.glare).toBe(0.1);

    const v = await call("validate_scene", { sceneId });
    expect(v.data.valid).toBe(true);

    const summary = await call("get_scene", { sceneId });
    expect(summary.data.scene.nodes.map((n: { id: string }) => n.id)).toEqual(["phone", "plane", "text"]);
    expect(summary.data.scene.tracks).toHaveLength(1);

    // Export → import under a new id → export again: byte-identical except the id.
    const exported = await call("export_scene", { sceneId, path: "exports/hero.json" });
    const file = readFileSync(join(root, "exports/hero.json"), "utf8");
    expect(JSON.parse(file).id).toBe(sceneId);
    const imported = await call("import_scene", { scene: exported.data.scene, id: "hero-copy" });
    expect(imported.data.valid).toBe(true);
    const reexported = await call("export_scene", { sceneId: "hero-copy" });
    expect({ ...reexported.data.scene, id: sceneId }).toEqual(exported.data.scene);
  });

  it("returns structured, actionable errors", async () => {
    const r = await call("add_device", { sceneId: "missing" });
    expect(r.isError).toBe(true);
    expect(r.data.error.code).toBe("SCENE_NOT_FOUND");
    expect(r.data.error.hint).toBeTruthy();

    const { data } = await call("create_scene", { id: "s" });
    expect(data.sceneId).toBe("s");
    const bad = await call("add_device", { sceneId: "s", screen: "screens/nope.png" });
    expect(bad.data.error.code).toBe("FILE_NOT_FOUND");
    expect(bad.data.error.message).toContain(join(root, "screens/nope.png"));

    const traversal = await call("import_asset", { sceneId: "s", path: "../../etc/passwd" });
    expect(["PATH_OUTSIDE_WORKSPACE", "FILE_NOT_FOUND"]).toContain(traversal.data.error.code);

    const track = await call("set_track", { sceneId: "s", target: "camera", property: "rotation", keyframes: [{ t: 0, value: [0, 0, 0] }] });
    expect(track.data.error.code).toBe("INVALID_TRACK_PROPERTY");
    expect(track.data.error.message).toContain("fov");
  });

  it("reports NOT_IMPLEMENTED for rendering when no renderer is attached", async () => {
    await call("create_scene", { id: "s" });
    const r = await call("render", { sceneId: "s" });
    expect(r.data.error.code).toBe("NOT_IMPLEMENTED");
    const p = await call("render_preview", { sceneId: "s" });
    expect(p.data.error.code).toBe("NOT_IMPLEMENTED");
  });

  it("surfaces validation issues on mutations", async () => {
    await call("create_scene", { id: "s" });
    await call("add_device", { sceneId: "s" });
    const r = await call("set_track", { sceneId: "s", target: "phone", property: "opacity", keyframes: [{ t: 30, value: 0 }] });
    expect(r.data.issues.join(" ")).toContain("after the timeline end");
  });
});
