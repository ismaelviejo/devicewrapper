import { describe, expect, it } from "vitest";
import { Scene, sceneJsonSchema, DeviceDefinition } from "@devicewrapper/schema";
import { canonicalStringify, hashValue, parseScene, migrateScene, DwError } from "@devicewrapper/core";
import { readFileSync, readdirSync } from "node:fs";
import { BUILTIN_ASSETS_DIR } from "@devicewrapper/core";
import { join } from "node:path";

describe("scene schema", () => {
  it("fills every default from just an id", () => {
    const s = Scene.parse({ id: "a" });
    expect(s.schemaVersion).toBe(1);
    expect(s.canvas).toEqual({ width: 1920, height: 1080, fps: 30, duration: 5 });
    expect(s.camera.type).toBe("perspective");
    expect(s.nodes).toEqual([]);
    expect(s.render.format).toBe("png");
  });

  it("applies node defaults per kind", () => {
    const s = Scene.parse({ id: "a", nodes: [{ id: "p", kind: "device", model: "phone-modern" }, { id: "f", kind: "plane" }] });
    const d = s.nodes[0]!;
    expect(d.kind === "device" && d.screen.fit).toBe("cover");
    expect(d.kind === "device" && d.screen.focus).toEqual([0.5, 0]);
    const f = s.nodes[1]!;
    expect(f.kind === "plane" && f.receiveShadow).toBe(true);
  });

  it("rejects bad colors, ids and unknown node kinds", () => {
    expect(Scene.safeParse({ id: "a", background: { type: "solid", color: "red" } }).success).toBe(false);
    expect(Scene.safeParse({ id: "bad id" }).success).toBe(false);
    expect(Scene.safeParse({ id: "a", nodes: [{ id: "x", kind: "teapot" }] }).success).toBe(false);
  });

  it("exports a JSON Schema", () => {
    const js = sceneJsonSchema();
    expect(js.type).toBe("object");
    expect(JSON.stringify(js)).toContain("background");
  });

  it("every built-in device definition is valid", () => {
    const dir = join(BUILTIN_ASSETS_DIR, "devices");
    for (const f of readdirSync(dir)) {
      const d = DeviceDefinition.parse(JSON.parse(readFileSync(join(dir, f), "utf8")));
      expect(d.screen.width).toBeLessThan(d.body.width);
      expect(d.screen.height).toBeLessThan(d.body.height);
    }
  });
});

describe("canonical serialization", () => {
  it("sorts keys and is stable across key order", () => {
    const a = canonicalStringify({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } });
    const b = canonicalStringify({ a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(a.endsWith("\n")).toBe(true);
  });

  it("normalizes -0 and drops undefined", () => {
    expect(canonicalStringify({ x: -0, y: undefined })).toBe('{\n  "x": 0\n}\n');
  });

  it("round-trips a scene byte-identically", () => {
    const s = parseScene({ id: "rt", nodes: [{ id: "phone", kind: "device", model: "phone-modern", transform: { rotation: [0, -20, 0] } }] });
    const text = canonicalStringify(s);
    const again = canonicalStringify(parseScene(JSON.parse(text)));
    expect(again).toBe(text);
    expect(hashValue(s)).toBe(hashValue(parseScene(JSON.parse(text))));
  });

  it("migrates missing schemaVersion and refuses newer versions", () => {
    expect((migrateScene({ id: "x" }) as { schemaVersion: number }).schemaVersion).toBe(1);
    expect(() => migrateScene({ id: "x", schemaVersion: 99 })).toThrow(DwError);
  });
});
