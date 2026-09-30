import { isDwError } from "@devicewrapper/core";
import type { Scene } from "@devicewrapper/schema";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type ToolResult = CallToolResult;

/** Success result: human-readable JSON text plus the same object as structured content. */
export function ok(data: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

/** Error result the agent can act on: { error: { code, message, path, hint, details } }. */
export function fail(e: unknown): ToolResult {
  const error = isDwError(e)
    ? e.toJSON()
    : { code: "INTERNAL_ERROR", message: `Unexpected error: ${(e as Error)?.message ?? String(e)}`, hint: "This is a bug in devicewrapper; the scene was not changed." };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error }, null, 2) }],
    structuredContent: { error },
  };
}

export function wrap<A>(fn: (args: A) => Promise<ToolResult> | ToolResult): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      return fail(e);
    }
  };
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const vec = (v: readonly number[]) => v.map(r3);

/** Compact overview of a scene, sized for an agent's context window. */
export function summarizeScene(scene: Scene): Record<string, unknown> {
  return {
    id: scene.id,
    ...(scene.name ? { name: scene.name } : {}),
    canvas: scene.canvas,
    background:
      scene.background.type === "gradient"
        ? { type: "gradient", kind: scene.background.kind, stops: scene.background.stops.map((s) => s.color) }
        : scene.background,
    environment: scene.environment,
    camera: {
      type: scene.camera.type,
      position: vec(scene.camera.position),
      target: vec(scene.camera.target),
      fov: r3(scene.camera.fov),
      ...(scene.camera.dof.enabled ? { dof: scene.camera.dof } : {}),
    },
    lights: scene.lights.map((l) => ({ id: l.id, type: l.type, intensity: l.intensity, color: l.color })),
    nodes: scene.nodes.map((n) => {
      if (n.kind === "text2d") return { id: n.id, kind: n.kind, content: n.content, anchor: n.anchor, size: n.size };
      const base: Record<string, unknown> = {
        id: n.id,
        kind: n.kind,
        position: vec(n.transform.position),
        rotation: vec(n.transform.rotation),
        ...(n.transform.scale !== 1 ? { scale: n.transform.scale } : {}),
        ...(n.parent ? { parent: n.parent } : {}),
        ...(!n.visible ? { visible: false } : {}),
      };
      if (n.kind === "device") {
        base.model = n.model;
        if (n.color) base.color = n.color;
        const src = n.screen.source;
        base.screen = src.type === "color" ? `color ${src.color}` : `${src.type} asset '${src.asset}' (${n.screen.fit})`;
      }
      if (n.kind === "primitive") base.shape = n.shape;
      if (n.kind === "plane" || n.kind === "primitive") base.material = typeof n.material === "string" ? n.material : n.material.type;
      return base;
    }),
    assets: Object.fromEntries(
      Object.entries(scene.assets).map(([id, a]) => [id, `${a.type} ${a.path}${a.width ? ` ${a.width}x${a.height}` : ""}${a.duration ? ` ${a.duration.toFixed(2)}s` : ""}`]),
    ),
    tracks: scene.animation.tracks.map((t) => ({
      target: t.target,
      property: t.property,
      keyframes: t.keyframes.length,
      from: t.keyframes[0]!.t,
      to: t.keyframes[t.keyframes.length - 1]!.t,
    })),
    effects: scene.effects.map((e) => e.type),
    variables: Object.keys(scene.variables),
    locales: Object.keys(scene.locales),
    render: scene.render,
  };
}
