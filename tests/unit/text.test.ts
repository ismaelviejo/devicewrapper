import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Workspace, addNode, applyMotion, composeScene, createScene, evaluateFrame, loadConfig, scriptsNotInInter, setVariables, validateScene, type Scene } from "@devicewrapper/core";
import { devices, tmpWorkspace, writeScreenshot } from "../helpers.js";

const caps = { backgrounds: ["solid"], screenSources: ["image"], effects: [], depthOfField: false, text: true, video: false, fonts: ["Inter"], stillFormats: ["png"], videoFormats: [] };

describe("text layout in compose", () => {
  let root: string;
  let cleanup: () => void;
  let ws: Workspace;
  beforeEach(async () => {
    ({ root, cleanup } = tmpWorkspace());
    ws = new Workspace(loadConfig({ DEVICEWRAPPER_WORKSPACE: root }, root));
    await writeScreenshot(join(root, "a.png"), 118, 256);
  });
  afterEach(() => cleanup());

  it("stacks a headline and subtitle at the top, and captions at the bottom", async () => {
    const s = await composeScene(ws, devices, {
      devices: [{ screen: "a.png" }],
      text: [{ content: "Train smarter" }, { content: "Plans that adapt to you" }, { content: "Available on iOS", position: "bottom" }],
    }, "t");
    const texts = s.nodes.filter((n) => n.kind === "text2d") as Array<Extract<Scene["nodes"][number], { kind: "text2d" }>>;
    expect(texts).toHaveLength(3);
    const [h, sub, cap] = texts;
    expect(sub!.anchor[1]).toBeGreaterThan(h!.anchor[1]);
    expect(sub!.size).toBeLessThan(h!.size);
    expect(sub!.weight).toBe(500);
    expect(cap!.anchor[1]).toBeCloseTo(0.9, 5);
    // Subject shifted down to leave room for two top lines.
    expect(s.camera.target[1]).toBeGreaterThan(0);
  });
});

describe("text motions", () => {
  const base = () => {
    let s = createScene({ id: "m" });
    s = addNode(s, { kind: "device", model: "phone-modern" }, devices).scene;
    s = addNode(s, { id: "title", kind: "text2d", content: "Hi", anchor: [0.5, 0.1] }, devices).scene;
    return addNode(s, { id: "sub", kind: "text2d", content: "There", anchor: [0.5, 0.18] }, devices).scene;
  };

  it("rise animates the anchor and fades in, ending at the layout position", () => {
    const r = applyMotion(base(), { preset: "rise", target: "title" }, devices);
    expect(evaluateFrame(r.scene, 0).nodes.title!.opacity).toBe(0);
    expect(evaluateFrame(r.scene, 0).nodes.title!.anchor![1]).toBeGreaterThan(0.1);
    expect(evaluateFrame(r.scene, 5).nodes.title!.anchor).toEqual([0.5, 0.1]);
    expect(validateScene(r.scene, { devices }).valid).toBe(true);
  });

  it("target 'texts' animates every text with a stagger", () => {
    const r = applyMotion(base(), { preset: "fade-in", target: "texts" }, devices);
    expect(r.animated.map((a) => a.target)).toEqual(["title", "sub"]);
    expect(r.animated[1]!.from).toBeCloseTo(0.15);
  });

  it("rejects device-only motions on text", () => {
    expect(() => applyMotion(base(), { preset: "turntable", target: "title" }, devices)).toThrow(/does not apply to text/);
  });
});

describe("fonts and scripts", () => {
  it("detects scripts Inter doesn't cover", () => {
    expect(scriptsNotInInter("Entrena mejor, cada día — Привет, Γειά")).toEqual([]);
    expect(scriptsNotInInter("もっと賢くトレーニング")).toEqual(["Japanese/Chinese"]);
    expect(scriptsNotInInter("더 스마트하게")).toEqual(["Korean"]);
    expect(scriptsNotInInter("تدرب بذكاء")).toEqual(["Arabic"]);
  });

  it("warns about system-font fallback per locale, and about unknown fonts", () => {
    let s = createScene({ id: "f" });
    s = addNode(s, { kind: "text2d", content: "{{headline}}", font: "Helvetica Neue" }, devices).scene;
    s = setVariables(s, { variables: { headline: "Train smarter" } });
    s = setVariables(s, { locale: "ja", variables: { headline: "もっと賢く" } });
    const codes = validateScene(s, { devices, capabilities: caps }).warnings.map((w) => w.code);
    expect(codes).toContain("SYSTEM_FONT_FALLBACK");
    expect(codes).toContain("UNKNOWN_FONT");
    s.assets.brand = { type: "font", path: "brand.ttf" };
    s = { ...s, nodes: s.nodes.map((n) => (n.kind === "text2d" ? { ...n, font: "brand" } : n)) };
    const codes2 = validateScene(s, { devices, capabilities: caps, checkFiles: false }).warnings.map((w) => w.code);
    expect(codes2).not.toContain("UNKNOWN_FONT");
    expect(codes2).not.toContain("SYSTEM_FONT_FALLBACK");
  });
});
