import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LAYOUT_NAMES,
  MOTION_NAMES,
  STYLE_NAMES,
  Workspace,
  addNode,
  applyLayout,
  applyMotion,
  applyStyle,
  boundsOf,
  composeScene,
  createScene,
  evaluateFrame,
  expandTemplate,
  hashValue,
  loadConfig,
  loadTemplates,
  validateScene,
  parseScene,
  worldPoints,
  deviceSize,
  type Scene,
} from "@devicewrapper/core";
import { devices, tmpWorkspace, writeScreenshot } from "../helpers.js";

const withDevices = (models: string[]): Scene => {
  let s = createScene({ id: "c" });
  for (const m of models) s = addNode(s, { kind: "device", model: m }, devices).scene;
  return s;
};
const pos = (s: Scene, id: string) => {
  const n = s.nodes.find((x) => x.id === id)!;
  return n.kind === "text2d" ? [0, 0, 0] : n.transform.position;
};

describe("device forms", () => {
  it("every model has sensible real-world dimensions", () => {
    for (const d of devices.list()) {
      const [w, h, dep] = deviceSize(d);
      expect(w, d.id).toBeGreaterThan(0.03);
      expect(h, d.id).toBeGreaterThan(0.03);
      expect(dep, d.id).toBeGreaterThan(0.004);
      expect(Math.max(w, h, dep), d.id).toBeLessThan(0.8);
    }
  });

  it("laptop bounds follow the lid angle", () => {
    const def = devices.require("laptop-14");
    expect(deviceSize(def, 0)[1]).toBeLessThan(0.03); // closed: just the thickness
    expect(deviceSize(def, 90)[1]).toBeGreaterThan(0.2); // upright
  });
});

describe("layouts", () => {
  it("every layout validates and keeps devices on one floor line", () => {
    for (const layout of LAYOUT_NAMES) {
      const s = applyLayout(withDevices(["phone-modern", "phone-modern", "phone-classic"]), { layout }, devices);
      expect(validateScene(s, { devices }).valid, layout).toBe(true);
      if (layout === "row" || layout === "arc" || layout === "stack" || layout === "circle") {
        const bottoms = s.nodes.filter((n) => n.kind === "device").map((n) => boundsOf(worldPoints(s, [n.id], devices))!.min[1]);
        for (const b of bottoms) expect(b, layout).toBeCloseTo(bottoms[0]!, 2);
      }
    }
  });

  it("row does not overlap and is centered", () => {
    const s = applyLayout(withDevices(["phone-modern", "phone-modern", "phone-modern"]), { layout: "row" }, devices);
    const xs = ["phone", "phone-2", "phone-3"].map((id) => pos(s, id)[0]!);
    expect(xs[0]! + xs[2]!).toBeCloseTo(0, 6);
    expect(xs[1]! - xs[0]!).toBeGreaterThan(0.0716);
  });

  it("arc is symmetric and turns outer devices inward", () => {
    const s = applyLayout(withDevices(["phone-modern", "phone-modern", "phone-modern"]), { layout: "arc", angle: 20 }, devices);
    const rot = (id: string) => (s.nodes.find((n) => n.id === id)! as { transform: { rotation: number[] } }).transform.rotation[1]!;
    expect(rot("phone")).toBeCloseTo(20);
    expect(rot("phone-3")).toBeCloseTo(-20);
    expect(pos(s, "phone-2")[2]).toBeGreaterThan(pos(s, "phone")[2]!);
  });

  it("circle groups devices in a carousel; other layouts ungroup them", () => {
    let s = applyLayout(withDevices(["phone-modern", "phone-modern", "phone-modern"]), { layout: "circle" }, devices);
    expect(s.nodes.some((n) => n.id === "carousel")).toBe(true);
    s = applyLayout(s, { layout: "row" }, devices);
    expect(s.nodes.some((n) => n.id === "carousel")).toBe(false);
  });

  it("showcase puts the largest device in the middle", () => {
    const s = applyLayout(withDevices(["phone-modern", "laptop-14"]), { layout: "showcase" }, devices);
    expect(pos(s, "laptop")[0]).toBe(0);
    expect(pos(s, "phone")[2]).toBeGreaterThan(0);
  });
});

describe("styles", () => {
  it("every style applies cleanly and adds a fitted floor", () => {
    for (const style of STYLE_NAMES) {
      const s = applyStyle(applyLayout(withDevices(["phone-modern"]), { layout: "hero" }, devices), { style, recolorDevices: true }, devices);
      expect(validateScene(s, { devices }).valid, style).toBe(true);
      const floor = s.nodes.find((n) => n.id === "floor");
      const bottom = boundsOf(worldPoints(s, ["phone"], devices))!.min[1];
      expect(floor && floor.kind === "plane" && floor.transform.position[1], style).toBeCloseTo(bottom, 2);
    }
  });

  it("glossy styles use a reflective floor and their own environment", () => {
    const s = applyStyle(withDevices(["phone-modern"]), { style: "glossy-dark" }, devices);
    const floor = s.nodes.find((n) => n.id === "floor");
    expect(floor?.kind === "plane" && floor.material).toMatchObject({ type: "reflective", strength: 0.28 });
    expect(s.environment.preset).toBe("softbox");
    // A style without an environment keeps the lighting preset's one; overriding the floor works.
    const t = applyStyle(s, { style: "light-studio", floor: { type: "reflective", fade: 0.8 } }, devices);
    expect(t.environment.preset).not.toBe("softbox");
    const f2 = t.nodes.find((n) => n.id === "floor");
    expect(f2?.kind === "plane" && f2.material).toMatchObject({ type: "reflective", fade: 0.8 });
  });

  it("warns when a reflective material is used on a primitive", () => {
    const s = parseScene({ id: "r", nodes: [{ id: "box", kind: "primitive", shape: "box", material: { type: "reflective" } }] });
    const codes = validateScene(s, { devices }).warnings.map((w) => w.code);
    expect(codes).toContain("NOT_RENDERED");
  });
});

describe("motions", () => {
  it("every preset produces valid tracks", () => {
    for (const preset of MOTION_NAMES) {
      const base = withDevices(preset.startsWith("lid-") ? ["laptop-14"] : ["phone-modern", "phone-modern"]);
      const r = applyMotion(applyLayout(base, { layout: "arc" }, devices), { preset }, devices);
      expect(r.animated.length, preset).toBeGreaterThan(0);
      expect(validateScene(r.scene, { devices }).valid, preset).toBe(true);
      // Evaluates at several times without throwing.
      for (const t of [0, 1, 2.5, 5]) evaluateFrame(r.scene, t);
    }
  });

  it("entrances end at the composed pose", () => {
    const s = applyLayout(withDevices(["phone-modern"]), { layout: "hero" }, devices);
    const r = applyMotion(s, { preset: "enter-left" }, devices);
    const f = evaluateFrame(r.scene, 5);
    const n = s.nodes[0]!;
    expect(f.nodes.phone!.position).toEqual(n.kind === "device" ? n.transform.position : []);
  });

  it("layers a second motion on the same property through a group", () => {
    let s = applyLayout(withDevices(["phone-modern"]), { layout: "hero" }, devices);
    s = applyMotion(s, { preset: "float" }, devices).scene;
    const r = applyMotion(s, { preset: "rise" }, devices);
    expect(r.wrapped).toEqual([{ node: "phone", group: "phone-motion" }]);
    const tracks = r.scene.animation.tracks.map((t) => `${t.target}.${t.property}`).sort();
    expect(tracks).toEqual(["phone-motion.opacity", "phone-motion.position", "phone.position"]);
  });

  it("extends the timeline when a motion runs past it", () => {
    const r = applyMotion(withDevices(["phone-modern"]), { preset: "slow-turn", start: 4, duration: 3 }, devices);
    expect(r.durationExtended).toBe(7);
    expect(r.scene.canvas.duration).toBe(7);
  });

  it("orbit keeps the camera distance to its target", () => {
    let s = withDevices(["phone-modern"]);
    const r = applyMotion(s, { preset: "orbit", amount: 60 }, devices);
    s = r.scene;
    const d0 = Math.hypot(...s.camera.position.map((v, i) => v - s.camera.target[i]!));
    for (const t of [0, 1.3, 2.5, 4.9]) {
      const c = evaluateFrame(s, t).camera;
      expect(Math.hypot(...c.position.map((v, i) => v - c.target[i]!))).toBeCloseTo(d0, 3);
    }
  });
});

describe("compose + templates", () => {
  let root: string;
  let cleanup: () => void;
  let ws: Workspace;
  beforeEach(async () => {
    ({ root, cleanup } = tmpWorkspace());
    ws = new Workspace(loadConfig({ DEVICEWRAPPER_WORKSPACE: root }, root));
    for (const n of [1, 2, 3, 4, 5, 6]) await writeScreenshot(join(root, `s${n}.png`), 118, 256);
    await writeScreenshot(join(root, "web.png"), 302, 196);
  });
  afterEach(() => cleanup());

  it("builds the premium dark phone brief from the original spec", async () => {
    const s = await composeScene(ws, devices, {
      concept: "Premium dark studio shot of an iPhone showing my fitness app",
      devices: [{ type: "phone", model: "phone-modern", screen: "s1.png" }],
      style: "dark-studio",
      camera: { shot: "hero" },
      motion: [{ preset: "slow-turn" }, { preset: "push-in" }],
      duration: 5,
    }, "fitness");
    expect(validateScene(s, { devices, workspace: ws }).valid).toBe(true);
    expect(s.description).toContain("Premium dark studio");
    expect(s.nodes.find((n) => n.kind === "device")!.kind === "device" && (s.nodes.find((n) => n.kind === "device") as { color?: string }).color).toBe("midnight");
    expect(s.animation.tracks.map((t) => `${t.target}.${t.property}`).sort()).toEqual(["camera.position", "phone.rotation"]);
  });

  it("builds 'three phones in an arc, blue gradient, center forward' from the original spec", async () => {
    const s = await composeScene(ws, devices, {
      devices: [{ screen: "s1.png" }, { screen: "s2.png" }, { screen: "s3.png" }],
      layout: "arc",
      style: "soft-gradient",
      motion: { preset: "rise", target: "phone-2" },
    }, "trio");
    expect(validateScene(s, { devices, workspace: ws }).valid).toBe(true);
    expect(pos(s, "phone-2")[2]).toBeGreaterThan(pos(s, "phone")[2]!);
    expect(Object.keys(s.assets).sort()).toEqual(["s1", "s2", "s3"]);
  });

  it("is deterministic", async () => {
    const brief = { devices: [{ screen: "s1.png" }, { model: "tablet", screen: "s2.png" }], style: "mint", text: [{ content: "Hi" }], motion: "float" };
    const a = await composeScene(ws, devices, brief, "x");
    const b = await composeScene(ws, devices, brief, "x");
    expect(hashValue(a)).toBe(hashValue(b));
  });

  it("rejects bad briefs with paths", async () => {
    await expect(composeScene(ws, devices, { devices: [] }, "x")).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
    await expect(composeScene(ws, devices, { devices: [{ model: "toaster" }] }, "x")).rejects.toMatchObject({ code: "UNKNOWN_DEVICE_MODEL" });
    await expect(composeScene(ws, devices, { devices: [{}], style: "vaporwave" }, "x")).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
  });

  it("every built-in template composes into a valid scene", async () => {
    const templates = loadTemplates();
    expect(templates.size).toBeGreaterThanOrEqual(12);
    for (const tpl of templates.values()) {
      const screens = Array.from({ length: Math.max(1, tpl.screens) }, (_, i) => `s${(i % 6) + 1}.png`);
      const brief = expandTemplate(tpl, screens, { headline: "Hello" });
      const s = await composeScene(ws, devices, brief, tpl.name);
      const report = validateScene(s, { devices, workspace: ws });
      expect(report.errors, tpl.name).toEqual([]);
      expect(s.nodes.filter((n) => n.kind === "device").length, tpl.name).toBe((tpl.brief.devices as unknown[]).length);
    }
  });

  it("expandTemplate repeats screens and applies overrides", () => {
    const tpl = loadTemplates().get("phone-trio")!;
    const brief = expandTemplate(tpl, ["a.png"], {}, { style: "mint" }) as { devices: Array<{ screen: string }>; style: string };
    expect(brief.devices.map((d) => d.screen)).toEqual(["a.png", "a.png", "a.png"]);
    expect(brief.style).toBe("mint");
  });
});
