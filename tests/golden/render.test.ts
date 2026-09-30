import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import sharp from "sharp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  addNode,
  createScene,
  ensureAsset,
  evaluateFrame,
  loadConfig,
  resolveScene,
  setBackground,
  setCamera,
  setEffects,
  setVariables,
  sha256,
  type Scene,
} from "@devicewrapper/core";
import { Engine } from "@devicewrapper/jobs";
import { createMcpServer } from "@devicewrapper/mcp";
import { ThreeChromiumRenderer } from "@devicewrapper/renderer";
import { tmpWorkspace, writeScreenshot } from "../helpers.js";

/**
 * Golden render tests. Deterministic (SwiftShader) mode renders identical pixels for the same
 * Chromium build; the tolerance absorbs tiny differences between builds/platforms.
 * Regenerate references with UPDATE_GOLDEN=1 pnpm test:golden and inspect the diff images.
 */
const GOLDEN_DIR = fileURLToPath(new URL("./reference", import.meta.url));
const ACTUAL_DIR = fileURLToPath(new URL("./__actual__", import.meta.url));
const MAX_DIFF_RATIO = 0.005;

let root: string;
let cleanup: () => void;
let engine: Engine;
let backend: ThreeChromiumRenderer;

beforeAll(async () => {
  ({ root, cleanup } = tmpWorkspace());
  await writeScreenshot(join(root, "screens/home.png"), 590, 1278, "#4f7cff");
  await writeScreenshot(join(root, "screens/red.png"), 590, 1278, "#ff5a5f");
  const config = loadConfig({ DEVICEWRAPPER_WORKSPACE: root, DEVICEWRAPPER_RENDER_MODE: "deterministic" }, root);
  backend = new ThreeChromiumRenderer({ config, poolSize: 1 });
  engine = new Engine({ config, backend });
});

afterAll(async () => {
  await engine.close();
  cleanup();
});

async function render(scene: Scene, w = 320, h = 180, opts: { transparent?: boolean; locale?: string } = {}): Promise<Buffer> {
  const resolved = resolveScene(scene, { devices: engine.devices, ...(opts.locale ? { locale: opts.locale } : {}), resolveAssetPath: (p) => engine.ws.resolveRead(p) });
  return backend.renderStill(resolved, evaluateFrame(scene, scene.render.time), {
    width: w,
    height: h,
    supersample: 2,
    transparent: opts.transparent ?? false,
    format: "png",
    quality: 90,
  });
}

function compareGolden(name: string, png: Buffer): void {
  mkdirSync(GOLDEN_DIR, { recursive: true });
  mkdirSync(ACTUAL_DIR, { recursive: true });
  const refPath = join(GOLDEN_DIR, `${name}.png`);
  writeFileSync(join(ACTUAL_DIR, `${name}.png`), png);
  if (process.env.UPDATE_GOLDEN === "1" || !existsSync(refPath)) {
    writeFileSync(refPath, png);
    return;
  }
  const a = PNG.sync.read(readFileSync(refPath));
  const b = PNG.sync.read(png);
  expect([b.width, b.height]).toEqual([a.width, a.height]);
  const diff = new PNG({ width: a.width, height: a.height });
  const changed = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 });
  const ratio = changed / (a.width * a.height);
  if (ratio > MAX_DIFF_RATIO) writeFileSync(join(ACTUAL_DIR, `${name}.diff.png`), PNG.sync.write(diff));
  expect(ratio, `${name}: ${(ratio * 100).toFixed(2)}% of pixels differ (see tests/golden/__actual__)`).toBeLessThanOrEqual(MAX_DIFF_RATIO);
}

async function heroScene(): Promise<Scene> {
  let s = createScene({ id: "hero", lighting: "studio", canvas: { width: 320, height: 180 } });
  const r = await ensureAsset(engine.ws, s, "screens/home.png");
  s = r.scene;
  s = addNode(s, { kind: "device", model: "phone-modern", color: "black", transform: { rotation: [0, -20, 0] }, screen: { source: { type: "image", asset: r.assetId } } }, engine.devices).scene;
  s = addNode(s, { kind: "plane", transform: { position: [0, -0.0743, 0] }, material: { type: "shadowCatcher", opacity: 0.35 } }, engine.devices).scene;
  s = setBackground(s, { type: "gradient", kind: "radial", center: [0.5, 0.4], stops: [{ color: "#ffffff", offset: 0 }, { color: "#d9dee8", offset: 1 }] });
  return setCamera(s, { focalLength: 70, frame: { shot: "hero" } }, engine.devices);
}

describe("golden renders", () => {
  it("hero phone on a radial gradient", async () => {
    compareGolden("hero-phone", await render(await heroScene()));
  });

  it("dark trio with localized text and vignette", async () => {
    let s = createScene({ id: "trio", lighting: "dark", canvas: { width: 320, height: 180 } });
    const a = await ensureAsset(engine.ws, s, "screens/home.png");
    s = a.scene;
    const b = await ensureAsset(engine.ws, s, "screens/red.png");
    s = b.scene;
    [a.assetId, b.assetId, a.assetId].forEach((asset, i) => {
      s = addNode(s, { kind: "device", model: i === 1 ? "phone-classic" : "phone-modern", color: i === 1 ? "graphite" : "midnight", transform: { position: [(i - 1) * 0.085, 0, i === 1 ? 0.02 : 0], rotation: [0, (1 - i) * 16, 0] }, screen: { source: { type: "image", asset } } }, engine.devices).scene;
    });
    s = addNode(s, { kind: "text2d", content: "{{headline}}", size: 20, weight: 700, color: "#ffffff", anchor: [0.5, 0.1] }, engine.devices).scene;
    s = setVariables(s, { variables: { headline: "Train smarter" } });
    s = setVariables(s, { locale: "es", variables: { headline: "Entrena mejor" } });
    s = setBackground(s, { type: "gradient", angle: 180, stops: [{ color: "#1b1d24", offset: 0 }, { color: "#07080b", offset: 1 }] });
    s = setEffects(s, { upsert: [{ type: "vignette", strength: 0.4 }] });
    s = setCamera(s, { focalLength: 55, frame: { shot: "hero", padding: 0.35 } }, engine.devices);
    compareGolden("dark-trio-en", await render(s));
    compareGolden("dark-trio-es", await render(s, 320, 180, { locale: "es" }));
  });

  it("tablet, orthographic top-down, transparent background", async () => {
    let s = createScene({ id: "flat", lighting: "bright", canvas: { width: 240, height: 240 } });
    const r = await ensureAsset(engine.ws, s, "screens/home.png");
    s = r.scene;
    s = addNode(s, { kind: "device", model: "tablet", transform: { rotation: [-90, 0, 12] }, screen: { source: { type: "image", asset: r.assetId }, fit: "contain", background: "#ffffff" } }, engine.devices).scene;
    s = setBackground(s, { type: "transparent" });
    s = setCamera(s, { patch: { type: "orthographic" }, frame: { shot: "top-down", padding: 0.1 } }, engine.devices);
    const png = await render(s, 240, 240, { transparent: true });
    compareGolden("tablet-topdown-transparent", png);
    const stats = await sharp(png).stats();
    expect(stats.channels[3]!.min).toBe(0);
    expect(stats.channels[3]!.max).toBe(255);
  });

  it("is deterministic: identical bytes on repeat renders", async () => {
    const s = await heroScene();
    const a = await render(s);
    const b = await render(s);
    expect(sha256(a)).toBe(sha256(b));
  });
});

describe("MCP render tools with a real renderer", () => {
  it("render_preview returns an inline PNG and render writes the file", async () => {
    const server = createMcpServer(engine);
    const [ta, tb] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "golden", version: "0" });
    await Promise.all([server.connect(ta), client.connect(tb)]);
    try {
      engine.store.save(await heroScene());
      const preview = await client.callTool({ name: "render_preview", arguments: { sceneId: "hero", size: 256 } });
      const img = (preview.content as Array<{ type: string; data?: string; mimeType?: string }>).find((c) => c.type === "image");
      expect(img?.mimeType).toBe("image/png");
      const meta = await sharp(Buffer.from(img!.data!, "base64")).metadata();
      expect([meta.width, meta.height]).toEqual([256, 144]);

      const r = await client.callTool({ name: "render", arguments: { sceneId: "hero", format: "webp", width: 400, wait: 120 } });
      const data = JSON.parse((r.content as Array<{ text: string }>)[0]!.text);
      expect(data.jobs[0].status).toBe("completed");
      const out = await sharp(join(root, data.jobs[0].output)).metadata();
      expect([out.format, out.width, out.height]).toEqual(["webp", 400, 225]);
    } finally {
      await client.close();
    }
  });
});
