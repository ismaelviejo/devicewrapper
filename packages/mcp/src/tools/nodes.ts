import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DwError, addNode, ensureAsset, removeNode, updateNode, type Workspace } from "@devicewrapper/core";
import type { Scene } from "@devicewrapper/schema";
import type { Engine } from "@devicewrapper/jobs";
import { Id, Vec3 } from "@devicewrapper/schema";
import { mutate } from "../helpers.js";
import { ok, wrap } from "../result.js";
import { DeviceScreenInput, NewNode, NodeId, SceneId } from "../schemas.js";

/** Turns the `screen` shortcut (asset ID, file path, or object) into a screen patch, importing files as needed. */
async function screenPatch(ws: Workspace, scene: Scene, screen: unknown): Promise<{ scene: Scene; patch: Record<string, unknown>; imported?: string }> {
  if (typeof screen === "string") {
    const r = await ensureAsset(ws, scene, screen);
    const a = r.scene.assets[r.assetId]!;
    if (a.type !== "image" && a.type !== "video") {
      throw new DwError("ASSET_TYPE_MISMATCH", `Asset '${r.assetId}' is a ${a.type}; screens show images or videos.`);
    }
    return { scene: r.scene, patch: { source: { type: a.type, asset: r.assetId } }, ...(r.imported ? { imported: r.assetId } : {}) };
  }
  const obj = { ...(screen as Record<string, unknown>) };
  const src = obj.source as Record<string, unknown> | undefined;
  if (src && (src.type === "image" || src.type === "video") && typeof src.asset === "string") {
    const r = await ensureAsset(ws, scene, src.asset, src.type);
    obj.source = { ...src, asset: r.assetId };
    return { scene: r.scene, patch: obj, ...(r.imported ? { imported: r.assetId } : {}) };
  }
  return { scene, patch: obj };
}

export function registerNodeTools(server: McpServer, engine: Engine): void {
  server.registerTool(
    "add_device",
    {
      title: "Add device",
      description: [
        "Add a device (phone, tablet, ...) to a scene. Real-world size in meters, centered at `position`, screen facing +Z (toward the default camera).",
        `Models: ${engine.devices.ids().join(", ")}. Colors per model are in the devicewrapper://devices resource (or pass a hex color).`,
        "`screen` accepts an asset ID, or a workspace file path to a PNG/JPEG/WebP/SVG screenshot (imported automatically), or a full screen object.",
        "Screenshots are fit with 'cover' anchored to the top by default, which suits app screens.",
        "Example: { sceneId: 'hero', model: 'phone-modern', color: 'black', screen: 'screens/home.png', rotation: [0, -18, 0] }",
        "Then frame it: set_camera { sceneId, frame: { shot: 'hero' } }.",
      ].join("\n"),
      inputSchema: {
        sceneId: SceneId,
        model: z.string().default("phone-modern").describe("Device model ID."),
        id: Id.optional().describe("Default: 'phone', 'phone-2', 'tablet', … by category."),
        name: z.string().max(200).optional(),
        color: z.string().optional().describe("Color variant name (e.g. 'black', 'silver') or hex. Default: the model's first color."),
        screen: DeviceScreenInput.optional(),
        position: Vec3.optional().describe("Meters. Default [0,0,0]."),
        rotation: Vec3.optional().describe("Degrees [x,y,z]. E.g. [0,-20,0] turns the screen slightly to the right."),
        scale: z.number().positive().optional(),
        parent: Id.optional().describe("Group node to attach to."),
        castShadow: z.boolean().optional(),
      },
    },
    wrap(async (a) => {
      const res = await mutate(engine, a.sceneId, async (scene) => {
        let s = scene;
        const node: Record<string, unknown> = { kind: "device", model: a.model };
        if (a.id) node.id = a.id;
        if (a.name) node.name = a.name;
        if (a.color) node.color = a.color;
        if (a.parent) node.parent = a.parent;
        if (a.castShadow !== undefined) node.castShadow = a.castShadow;
        const transform: Record<string, unknown> = {};
        if (a.position) transform.position = a.position;
        if (a.rotation) transform.rotation = a.rotation;
        if (a.scale !== undefined) transform.scale = a.scale;
        if (Object.keys(transform).length) node.transform = transform;
        let imported: string | undefined;
        if (a.screen !== undefined) {
          const sp = await screenPatch(engine.ws, s, a.screen);
          s = sp.scene;
          node.screen = sp.patch;
          imported = sp.imported;
        }
        const r = addNode(s, node, engine.devices);
        const def = engine.devices.require(a.model);
        return {
          scene: r.scene,
          result: {
            nodeId: r.id,
            model: def.id,
            sizeMeters: [def.body.width, def.body.height, def.body.depth],
            ...(imported ? { importedAsset: imported } : {}),
          },
        };
      });
      return ok(res);
    }),
  );

  server.registerTool(
    "add_node",
    {
      title: "Add node",
      description: [
        "Add a non-device node:",
        "- plane: floor or wall. Faces +Y (a floor) by default; rotation [90,0,0] makes a wall facing the camera. For a floating device over a flat background, use material { type: 'shadowCatcher' } so only the shadow shows.",
        "- primitive: box | sphere | cylinder | cone | torus | capsule, sized in meters, for props and pedestals.",
        "- group: an empty transform; set other nodes' `parent` to it to move/rotate them together.",
        "- text2d: text drawn over the frame at a normalized `anchor` [x, y] (0..1, origin top-left); supports {{variables}} for localization.",
        "Example floor: { sceneId: 'hero', node: { kind: 'plane', transform: { position: [0, -0.08, 0] }, material: { type: 'shadowCatcher', opacity: 0.3 } } }",
        "Example headline: { sceneId: 'hero', node: { kind: 'text2d', content: '{{headline}}', anchor: [0.5, 0.1], size: 72, color: '#111111' } }",
      ].join("\n"),
      inputSchema: { sceneId: SceneId, node: NewNode },
    },
    wrap(async (a) => {
      const res = await mutate(engine, a.sceneId, (scene) => {
        const r = addNode(scene, a.node as Record<string, unknown>, engine.devices);
        return { scene: r.scene, result: { nodeId: r.id, kind: a.node.kind } };
      });
      return ok(res);
    }),
  );

  server.registerTool(
    "update_node",
    {
      title: "Update node",
      description: [
        "Change any node (device, plane, primitive, group, text2d). `patch` is a JSON Merge Patch over the node:",
        "objects merge, arrays and values replace, null deletes an optional field. id and kind cannot change.",
        "Common patches:",
        "- move/rotate: { transform: { position: [0, 0.02, 0], rotation: [0, -25, 0] } }",
        "- device color: { color: 'silver' }",
        "- screen fit/look: { screen: { fit: 'contain', background: '#ffffff', glare: 0.1 } }",
        "- hide: { visible: false }   - re-parent: { parent: 'group-1' }   - detach: { parent: null }",
        "- text: { content: 'New title', size: 80 }",
        "`screen` (optional) is the same shortcut as in add_device: an asset ID or a file path sets the screen content.",
      ].join("\n"),
      inputSchema: {
        sceneId: SceneId,
        id: NodeId,
        patch: z.record(z.string(), z.unknown()).default({}).describe("JSON Merge Patch applied to the node."),
        screen: DeviceScreenInput.optional(),
      },
      annotations: { idempotentHint: true },
    },
    wrap(async (a) => {
      const res = await mutate(engine, a.sceneId, async (scene) => {
        let s = scene;
        const patch: Record<string, unknown> = { ...a.patch };
        let imported: string | undefined;
        if (a.screen !== undefined) {
          const target = s.nodes.find((n) => n.id === a.id);
          if (target && target.kind !== "device") throw new DwError("NOT_A_DEVICE", `'${a.id}' is a ${target.kind}; only devices have screens.`);
          const sp = await screenPatch(engine.ws, s, a.screen);
          s = sp.scene;
          patch.screen = { ...((patch.screen as Record<string, unknown>) ?? {}), ...sp.patch };
          imported = sp.imported;
        }
        const next = updateNode(s, a.id, patch, engine.devices);
        const node = next.nodes.find((n) => n.id === a.id)!;
        return { scene: next, result: { nodeId: a.id, node, ...(imported ? { importedAsset: imported } : {}) } };
      });
      return ok(res);
    }),
  );

  server.registerTool(
    "remove_node",
    {
      title: "Remove node",
      description: "Remove a node and any animation tracks targeting it. Children are re-attached to the removed node's parent, or removed too with recursive: true.",
      inputSchema: { sceneId: SceneId, id: NodeId, recursive: z.boolean().default(false) },
      annotations: { destructiveHint: true },
    },
    wrap(async (a) => {
      const res = await mutate(engine, a.sceneId, (scene) => {
        const r = removeNode(scene, a.id, { recursive: a.recursive });
        return { scene: r.scene, result: { removed: r.removed, removedTracks: r.removedTracks } };
      });
      return ok(res);
    }),
  );
}
