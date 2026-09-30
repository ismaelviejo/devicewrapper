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
import { execFileSync } from "node:child_process";
import { setTrack } from "@devicewrapper/core";
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
  // A short hang timeout: on some runners a forced page crash shows up as a hang, not a crash event.
  backend = new ThreeChromiumRenderer({ config, poolSize: 1, frameTimeoutMs: 45_000 });
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
    s = setCamera(s, { focalLength: 55, frame: { shot: "hero", padding: 0.35, shift: [0, 0.1] } }, engine.devices);
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

describe("video", () => {
  const framemd5 = (path: string) => sha256(execFileSync("ffmpeg", ["-v", "error", "-i", path, "-f", "framemd5", "-"]).toString());

  it("renders an animated MP4 deterministically (identical frames on repeat)", async () => {
    let s = await heroScene();
    s = { ...s, id: "clip", canvas: { ...s.canvas, width: 160, height: 90, fps: 10, duration: 1 } };
    s = setTrack(s, { target: "phone", property: "rotation", keyframes: [{ t: 0, value: [0, -30, 0], easing: "easeInOut" }, { t: 1, value: [0, 30, 0] }] });
    engine.store.save(s);
    const outs: string[] = [];
    for (const k of [0, 1]) {
      const job = engine.jobs.create({ sceneId: "clip", format: "mp4", supersample: 1, output: `renders/clip-${k}.mp4` });
      const done = await engine.jobs.wait(job.jobId, 170000);
      expect(done.status, done.error?.message).toBe("completed");
      expect(done.frames).toEqual({ done: 10, total: 10 });
      outs.push(join(root, done.output));
    }
    expect(framemd5(outs[0]!)).toBe(framemd5(outs[1]!));
    const probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,width,height,nb_frames", "-of", "csv=p=0", outs[0]!]).toString().trim();
    expect(probe).toBe("h264,160,90,10");
  });

  it("plays a video on the screen and writes transparent ProRes", async () => {
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=300x640:rate=10:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", join(root, "rec.mp4")]);
    let s = createScene({ id: "vscreen", lighting: "product", canvas: { width: 120, height: 120, fps: 10, duration: 0.5 } });
    const r = await ensureAsset(engine.ws, s, "rec.mp4");
    s = r.scene;
    s = addNode(s, { kind: "device", model: "phone-modern", screen: { source: { type: "video", asset: r.assetId } } }, engine.devices).scene;
    s = setBackground(s, { type: "transparent" });
    s = setCamera(s, { frame: { shot: "front", padding: 0.05 } }, engine.devices);
    engine.store.save(s);
    const job = engine.jobs.create({ sceneId: "vscreen", format: "mov", supersample: 1 });
    const done = await engine.jobs.wait(job.jobId, 170000);
    expect(done.status, done.error?.message).toBe("completed");
    const probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,pix_fmt,nb_frames", "-of", "csv=p=0", join(root, done.output)]).toString().trim();
    expect(probe).toMatch(/^prores,yuva444p1[02]le,5$/);
    // Screen content changes between frames because the clip plays.
    const a = await render(s, 120, 120, { transparent: true });
    const s2 = { ...s, render: { ...s.render, time: 0.4 } };
    const b = await render(s2, 120, 120, { transparent: true });
    expect(sha256(a)).not.toBe(sha256(b));
  });

  it("refuses transparent MP4 but renders a transparent-background scene opaque with a warning", async () => {
    engine.store.save({ ...(await heroScene()), id: "tbg", background: { type: "transparent" }, canvas: { width: 64, height: 64, fps: 5, duration: 0.2 } });
    expect(() => engine.jobs.create({ sceneId: "tbg", format: "mp4", transparent: true })).toThrow(/transparency/);
    const job = engine.jobs.create({ sceneId: "tbg", format: "mp4", supersample: 1 });
    expect(job.warnings.map((w) => w.code)).toContain("NO_ALPHA");
    expect((await engine.jobs.wait(job.jobId, 60000)).status).toBe("completed");
  });
});

describe("device forms and templates", () => {
  it("renders laptop, monitor, watch and tablet templates", async () => {
    await writeScreenshot(join(root, "screens/web.png"), 604, 392, "#3d5afe");
    const { composeScene, expandTemplate, loadTemplates } = await import("@devicewrapper/core");
    const templates = loadTemplates();
    for (const name of ["hero-laptop", "desktop-setup", "watch-hero", "phone-tablet"]) {
      const tpl = templates.get(name)!;
      const screens = (tpl.brief.devices as Array<{ model: string }>).map((d) => (/laptop|monitor/.test(d.model) ? "screens/web.png" : "screens/home.png"));
      const scene = await composeScene(engine.ws, engine.devices, expandTemplate(tpl, screens), name);
      compareGolden(`template-${name}`, await render({ ...scene, canvas: { ...scene.canvas, width: 320, height: 180 } }));
    }
  });

  it("laptop lid animates via lidAngle", async () => {
    const { composeScene, expandTemplate, loadTemplates } = await import("@devicewrapper/core");
    const tpl = loadTemplates().get("laptop-reveal")!;
    const scene = await composeScene(engine.ws, engine.devices, expandTemplate(tpl, ["screens/web.png"]), "reveal");
    const s = { ...scene, canvas: { ...scene.canvas, width: 320, height: 180 } };
    const closed = await render({ ...s, render: { ...s.render, time: 0 } });
    const open = await render({ ...s, render: { ...s.render, time: 3 } });
    expect(sha256(closed)).not.toBe(sha256(open));
    compareGolden("laptop-reveal-t3", open);
  });
});

describe("post effects", () => {
  it("depth of field blurs devices behind the focus plane, bloom glows on dark scenes", async () => {
    const { composeScene, setEffects } = await import("@devicewrapper/core");
    await writeScreenshot(join(root, "screens/red.png"), 590, 1278, "#ff5a5f");
    const dof = await composeScene(engine.ws, engine.devices, { devices: [{ screen: "screens/home.png" }, { screen: "screens/red.png" }, { screen: "screens/home.png" }], layout: "stack", camera: { focalLength: 85, dof: 0.6 } }, "dof");
    const flat = { ...dof, camera: { ...dof.camera, dof: { ...dof.camera.dof, enabled: false } } };
    const small = (s: typeof dof) => ({ ...s, canvas: { ...s.canvas, width: 320, height: 180 } });
    const withDof = await render(small(dof));
    expect(sha256(withDof)).not.toBe(sha256(await render(small(flat))));
    compareGolden("dof-stack", withDof);
    let neon = await composeScene(engine.ws, engine.devices, { devices: [{ screen: "screens/home.png" }], style: "midnight-neon" }, "neon");
    neon = setEffects(neon, { upsert: [{ type: "bloom", strength: 0.6 }] });
    compareGolden("bloom-neon", await render(small(neon)));
    // Validation no longer flags DOF/bloom as unsupported.
    const codes = engine.validate(neon).warnings.map((w) => w.code);
    expect(codes).not.toContain("NOT_RENDERED");
  });

  it("reflective floor and softbox environment (glossy-dark) render deterministically", async () => {
    const { composeScene } = await import("@devicewrapper/core");
    const s = await composeScene(engine.ws, engine.devices, { devices: [{ screen: "screens/home.png" }, { screen: "screens/home.png" }], style: "glossy-dark", camera: { padding: 0.3 } }, "glossy");
    const small = { ...s, canvas: { ...s.canvas, width: 320, height: 180 } };
    const a = await render(small);
    expect(sha256(a)).toBe(sha256(await render(small)));
    compareGolden("glossy-dark", a);
  });
});

describe("resilience", () => {
  it("recovers from a renderer page crash in the middle of a video", async () => {
    let s = await heroScene();
    s = { ...s, id: "crashy", canvas: { ...s.canvas, width: 160, height: 90, fps: 10, duration: 2 } };
    s = setTrack(s, { target: "phone", property: "rotation", keyframes: [{ t: 0, value: [0, -30, 0] }, { t: 2, value: [0, 30, 0] }] });
    engine.store.save(s);
    const job = engine.jobs.create({ sceneId: "crashy", format: "mp4", supersample: 1 });
    // Crash the page once, a little after the render has started.
    const internals = backend as unknown as { slots: Array<{ page: { sessionId: string } }>; browser: { send(m: string, p: object, sid?: string): Promise<unknown> } };
    let crashed = false;
    const timer = setInterval(() => {
      const j = engine.jobs.get(job.jobId);
      if (!crashed && j.status === "running" && j.frames.done >= 0) {
        const sid = internals.slots[0]?.page.sessionId;
        if (sid) {
          crashed = true;
          void internals.browser.send("Page.crash", {}, sid).catch(() => undefined);
        }
      }
    }, 300);
    const done = await engine.jobs.wait(job.jobId, 170000);
    clearInterval(timer);
    expect(crashed).toBe(true);
    expect(done.status, done.error?.message).toBe("completed");
    expect(done.frames).toEqual({ done: 20, total: 20 });
    // The recovered video is identical to a clean render.
    const clean = engine.jobs.create({ sceneId: "crashy", format: "mp4", supersample: 1, output: "renders/clean.mp4" });
    const cleanDone = await engine.jobs.wait(clean.jobId, 170000);
    const framemd5 = (path: string) => sha256(execFileSync("ffmpeg", ["-v", "error", "-i", path, "-f", "framemd5", "-"]).toString());
    expect(framemd5(join(root, done.output))).toBe(framemd5(join(root, cleanDone.output)));
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

      const r = await client.callTool({ name: "render", arguments: { sceneId: "hero", format: "webp", width: 400, wait: 50 } });
      const data = JSON.parse((r.content as Array<{ text: string }>)[0]!.text);
      expect(data.jobs[0].status).toBe("completed");
      const out = await sharp(join(root, data.jobs[0].output)).metadata();
      expect([out.format, out.width, out.height]).toEqual(["webp", 400, 225]);
    } finally {
      await client.close();
    }
  });
});
