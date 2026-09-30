import { describe, expect, it } from "vitest";
import {
  DwError,
  addNode,
  createScene,
  mergePatch,
  removeNode,
  setBackground,
  setCamera,
  setEffects,
  setLights,
  setTrack,
  setVariables,
  updateNode,
  updateScene,
  worldPoints,
  validateScene,
  resolveScene,
  substitute,
  DEG,
  v3,
} from "@devicewrapper/core";
import { devices } from "../helpers.js";

const base = () => {
  let s = createScene({ id: "s" });
  s = addNode(s, { kind: "device", model: "phone-modern" }, devices).scene;
  return s;
};

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(DwError);
    expect((e as DwError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("mergePatch", () => {
  it("merges objects, replaces arrays, deletes on null", () => {
    expect(mergePatch({ a: { b: 1, c: 2 }, d: [1, 2], e: 1 }, { a: { c: 3 }, d: [9], e: null })).toEqual({ a: { b: 1, c: 3 }, d: [9] });
  });
});

describe("scene + nodes", () => {
  it("createScene applies a lighting preset", () => {
    const s = createScene({ id: "x", lighting: "dark" });
    expect(s.lights.map((l) => l.id)).toEqual(["key", "rim", "ambient"]);
    expect(createScene({ id: "y", lighting: "none" }).lights).toEqual([]);
  });

  it("allocates deterministic ids by category", () => {
    let s = base();
    const r2 = addNode(s, { kind: "device", model: "phone-modern" }, devices);
    s = r2.scene;
    const r3 = addNode(s, { kind: "device", model: "tablet" }, devices);
    expect([s.nodes[0]!.id, r2.id, r3.id]).toEqual(["phone", "phone-2", "tablet"]);
  });

  it("rejects duplicate ids across nodes and lights", () => {
    expectCode(() => addNode(base(), { id: "key", kind: "group" }, devices), "DUPLICATE_ID");
  });

  it("rejects unknown models and colors", () => {
    expectCode(() => addNode(base(), { kind: "device", model: "nope" }, devices), "UNKNOWN_DEVICE_MODEL");
    expectCode(() => addNode(base(), { kind: "device", model: "phone-modern", color: "plaid" }, devices), "UNKNOWN_DEVICE_COLOR");
    expect(addNode(base(), { kind: "device", model: "phone-modern", color: "#123456" }, devices).id).toBe("phone-2");
  });

  it("updateNode merges and keeps other fields", () => {
    const s = updateNode(base(), "phone", { transform: { rotation: [0, -20, 0] }, screen: { glare: 0.1 } }, devices);
    const n = s.nodes[0]!;
    expect(n.kind === "device" && n.transform.rotation).toEqual([0, -20, 0]);
    expect(n.kind === "device" && n.transform.position).toEqual([0, 0, 0]);
    expect(n.kind === "device" && n.screen.glare).toBe(0.1);
    expect(n.kind === "device" && n.screen.fit).toBe("cover");
  });

  it("updateNode forbids id/kind changes and parent cycles", () => {
    expectCode(() => updateNode(base(), "phone", { id: "other" }, devices), "IMMUTABLE_FIELD");
    expectCode(() => updateNode(base(), "phone", { kind: "plane" }, devices), "IMMUTABLE_FIELD");
    let s = addNode(base(), { id: "g", kind: "group" }, devices).scene;
    s = updateNode(s, "phone", { parent: "g" }, devices);
    expectCode(() => updateNode(s, "g", { parent: "phone" }, devices), "PARENT_CYCLE");
    expectCode(() => updateNode(s, "phone", { parent: "ghost" }, devices), "UNKNOWN_PARENT");
  });

  it("removeNode reparents children and removes tracks", () => {
    let s = addNode(base(), { id: "outer", kind: "group" }, devices).scene;
    s = addNode(s, { id: "inner", kind: "group", parent: "outer" }, devices).scene;
    s = updateNode(s, "phone", { parent: "inner" }, devices);
    s = setTrack(s, { target: "inner", property: "position", keyframes: [{ t: 0, value: [0, 0, 0] }] });
    const r = removeNode(s, "inner");
    expect(r.removedTracks).toBe(1);
    const phone = r.scene.nodes.find((n) => n.id === "phone")!;
    expect(phone.kind !== "text2d" && phone.parent).toBe("outer");
    const rec = removeNode(s, "outer", { recursive: true });
    expect(rec.removed.sort()).toEqual(["inner", "outer", "phone"]);
  });
});

describe("camera framing", () => {
  it("frames every corner of the targets inside the view", () => {
    for (const shot of ["front", "hero", "three-quarter", "top-down", "side"]) {
      const s = setCamera(base(), { frame: { shot } }, devices);
      const cam = s.camera;
      const forward = v3.norm(v3.sub(cam.target, cam.position));
      let up: [number, number, number] = [0, 1, 0];
      if (Math.abs(v3.dot(forward, up)) > 0.999) up = [0, 0, -1];
      const right = v3.norm(v3.cross(forward, up));
      const camUp = v3.cross(right, forward);
      const tanV = Math.tan((cam.fov * DEG) / 2);
      const tanH = tanV * (16 / 9);
      for (const p of worldPoints(s, ["phone"], devices)) {
        const d = v3.sub(p, cam.position);
        const z = v3.dot(d, forward);
        expect(z).toBeGreaterThan(0);
        expect(Math.abs(v3.dot(d, right)) / z).toBeLessThanOrEqual(tanH + 1e-6);
        expect(Math.abs(v3.dot(d, camUp)) / z).toBeLessThanOrEqual(tanV + 1e-6);
      }
    }
  });

  it("focalLength converts to fov", () => {
    expect(setCamera(base(), { focalLength: 50 }, devices).camera.fov).toBeCloseTo(26.99, 1);
  });

  it("rejects a degenerate camera", () => {
    expectCode(() => setCamera(base(), { patch: { position: [0, 0, 0], target: [0, 0, 0] } }, devices), "INVALID_CAMERA");
  });
});

describe("lights, background, effects", () => {
  it("merges light patches and requires a type for new lights", () => {
    let s = setLights(base(), { lights: [{ id: "key", intensity: 5 }] });
    expect(s.lights.find((l) => l.id === "key")!.intensity).toBe(5);
    expectCode(() => setLights(s, { lights: [{ id: "new" }] }), "MISSING_TYPE");
    s = setLights(s, { lights: [{ id: "back", type: "point", position: [0, 1, -1] }] });
    expect(s.lights.some((l) => l.id === "back")).toBe(true);
    s = setLights(s, { remove: ["back"] });
    expect(s.lights.some((l) => l.id === "back")).toBe(false);
  });

  it("presets replace lights and environment", () => {
    const s = setLights(base(), { preset: "dramatic" });
    expect(s.environment.intensity).toBe(0.25);
    expect(s.lights[0]!.type).toBe("spot");
  });

  it("validates backgrounds", () => {
    expect(setBackground(base(), { type: "gradient", stops: [{ color: "#000000", offset: 0 }, { color: "#ffffff", offset: 1 }] }).background.type).toBe("gradient");
    expectCode(() => setBackground(base(), { type: "gradient", stops: [{ color: "#000000", offset: 0 }] }), "SCHEMA_INVALID");
  });

  it("upserts effects by type", () => {
    let s = setEffects(base(), { upsert: [{ type: "vignette", strength: 0.2 }] });
    s = setEffects(s, { upsert: [{ type: "vignette", strength: 0.5 }, { type: "grain" }] });
    expect(s.effects).toHaveLength(2);
    expect(s.effects[0]).toMatchObject({ type: "vignette", strength: 0.5 });
    expect(setEffects(s, { remove: ["grain"] }).effects).toHaveLength(1);
  });
});

describe("tracks", () => {
  it("validates target, property and values", () => {
    expectCode(() => setTrack(base(), { target: "ghost", property: "position", keyframes: [{ t: 0, value: [0, 0, 0] }] }), "UNKNOWN_TRACK_TARGET");
    expectCode(() => setTrack(base(), { target: "phone", property: "fov", keyframes: [{ t: 0, value: 1 }] }), "INVALID_TRACK_PROPERTY");
    expectCode(() => setTrack(base(), { target: "phone", property: "position", keyframes: [{ t: 0, value: 3 }] }), "INVALID_KEYFRAME_VALUE");
    expectCode(() => setTrack(base(), { target: "phone", property: "opacity", keyframes: [{ t: 0, value: 2 }] }), "INVALID_KEYFRAME_VALUE");
    expectCode(() => setTrack(base(), { target: "phone", property: "position", keyframes: [{ t: 0, value: [0, 0, 0] }, { t: 0, value: [1, 1, 1] }] }), "DUPLICATE_KEYFRAME_TIME");
  });

  it("merge mode upserts keyframes by time and sorts", () => {
    let s = setTrack(base(), { target: "camera", property: "fov", keyframes: [{ t: 2, value: 30 }, { t: 0, value: 40 }] });
    s = setTrack(s, { target: "camera", property: "fov", mode: "merge", keyframes: [{ t: 2, value: 25 }, { t: 1, value: 35 }] });
    expect(s.animation.tracks[0]!.keyframes.map((k) => [k.t, k.value])).toEqual([[0, 40], [1, 35], [2, 25]]);
  });
});

describe("variables + localization", () => {
  it("sets base and locale variables and substitutes them", () => {
    let s = addNode(base(), { kind: "text2d", content: "{{headline}} ({{locale}})" }, devices).scene;
    s = setVariables(s, { variables: { headline: "Train smarter" } });
    s = setVariables(s, { locale: "es", variables: { headline: "Entrena mejor" } });
    const en = resolveScene(s, { devices, resolveAssetPath: (p) => p });
    const es = resolveScene(s, { devices, locale: "es", resolveAssetPath: (p) => p });
    const txt = (r: typeof en) => r.nodes.find((n) => n.kind === "text2d")!;
    expect(txt(en).kind === "text2d" && txt(en).content).toBe("Train smarter (en)");
    expect(txt(es).kind === "text2d" && txt(es).content).toBe("Entrena mejor (es)");
    expect(en.hash).not.toBe(es.hash);
  });

  it("leaves unknown placeholders visible", () => {
    expect(substitute("Hi {{name}} {{missing}}", { name: "Isma" })).toBe("Hi Isma {{missing}}");
  });

  it("rejects bad locale codes and variable names", () => {
    expectCode(() => setVariables(base(), { locale: "english!", variables: { a: "b" } }), "INVALID_LOCALE");
    expectCode(() => setVariables(base(), { variables: { "bad name": "x" } }), "INVALID_VARIABLE_NAME");
  });
});

describe("validation", () => {
  const codes = (input: unknown) => {
    const r = validateScene(input, { devices });
    return [...r.errors.map((e) => e.code), ...r.warnings.map((w) => `w:${w.code}`)];
  };

  it("a fresh scene with a phone is valid", () => {
    expect(validateScene(base(), { devices }).valid).toBe(true);
  });

  it("detects reference errors", () => {
    expect(codes({ id: "v", nodes: [{ id: "a", kind: "device", model: "nope" }] })).toContain("UNKNOWN_DEVICE_MODEL");
    expect(codes({ id: "v", nodes: [{ id: "a", kind: "group", parent: "b" }] })).toContain("UNKNOWN_PARENT");
    expect(codes({ id: "v", nodes: [{ id: "a", kind: "group", parent: "b" }, { id: "b", kind: "group", parent: "a" }] })).toContain("PARENT_CYCLE");
    expect(codes({ id: "v", nodes: [{ id: "a", kind: "group" }], lights: [{ id: "a", type: "ambient" }] })).toContain("DUPLICATE_ID");
    expect(codes({ id: "v", nodes: [{ id: "p", kind: "plane", material: "floor" }] })).toContain("UNKNOWN_MATERIAL");
    expect(codes({ id: "v", nodes: [{ id: "a", kind: "device", model: "phone-modern", screen: { source: { type: "image", asset: "shot" } } }] })).toContain("UNKNOWN_ASSET");
    expect(
      codes({
        id: "v",
        assets: { clip: { type: "video", path: "a.mp4" } },
        nodes: [{ id: "a", kind: "device", model: "phone-modern", screen: { source: { type: "image", asset: "clip" } } }],
      }),
    ).toContain("ASSET_TYPE_MISMATCH");
  });

  it("detects animation errors", () => {
    const withTracks = (tracks: unknown[]) => ({ id: "v", nodes: [{ id: "a", kind: "group" }], animation: { tracks } });
    expect(codes(withTracks([{ target: "zzz", property: "position", keyframes: [{ t: 0, value: [0, 0, 0] }] }]))).toContain("UNKNOWN_TRACK_TARGET");
    expect(codes(withTracks([{ target: "a", property: "fov", keyframes: [{ t: 0, value: 1 }] }]))).toContain("INVALID_TRACK_PROPERTY");
    expect(codes(withTracks([{ target: "a", property: "position", keyframes: [{ t: 0, value: true }] }]))).toContain("INVALID_KEYFRAME_VALUE");
    expect(codes(withTracks([{ target: "a", property: "position", keyframes: [{ t: 99, value: [0, 0, 0] }] }]))).toContain("w:KEYFRAME_AFTER_END");
  });

  it("warns on undefined variables and missing translations", () => {
    const c = codes({ id: "v", locales: { es: {} }, nodes: [{ id: "t", kind: "text2d", content: "{{headline}}" }] });
    expect(c).toContain("w:UNDEFINED_VARIABLE");
  });

  it("reports schema errors with paths", () => {
    const r = validateScene({ id: "v", canvas: { width: -5 } }, { devices });
    expect(r.valid).toBe(false);
    expect(r.errors[0]!.path).toBe("canvas.width");
  });

  it("warns when the renderer lacks a capability", () => {
    const r = validateScene(
      { id: "v", effects: [{ type: "bloom" }] },
      {
        devices,
        capabilities: { backgrounds: ["solid"], screenSources: [], effects: [], depthOfField: false, text: false, video: false, fonts: [], stillFormats: ["png"], videoFormats: [] },
      },
    );
    expect(r.warnings.map((w) => w.code)).toContain("NOT_RENDERED");
  });

  it("updateScene merges canvas and render", () => {
    const s = updateScene(base(), { canvas: { duration: 8 }, render: { format: "jpeg" } });
    expect(s.canvas).toMatchObject({ width: 1920, duration: 8 });
    expect(s.render.format).toBe("jpeg");
  });
});
