import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright-core";
import sharp from "sharp";
import {
  DwError,
  type DwConfig,
  type FrameState,
  type RenderBackend,
  type RendererCapabilities,
  type ResolvedScene,
  type StillOptions,
} from "@devicewrapper/core";
import type { LoadPayload, PageApi, PageBackground, PageFont, PageLimits, PageNode, RenderFrameOptions } from "./protocol.js";
import { prepareBackground, prepareScreenTexture } from "./textures.js";

const ORIGIN = "http://devicewrapper.local";
// Works from both dist/ (published) and src/ (tests): the bundle always lives in <package>/dist/page.
const PAGE_JS = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "page", "page.js");
const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:transparent}</style></head><body><script src="/page.js"></script></body></html>`;

export const CAPABILITIES: RendererCapabilities = {
  backgrounds: ["solid", "gradient", "image", "transparent"],
  screenSources: ["image", "color"],
  effects: ["vignette", "fog", "grain"],
  depthOfField: false,
  text: true,
  video: false,
  fonts: ["Inter"],
  stillFormats: ["png", "jpeg", "webp"],
  videoFormats: [],
};

interface Resource {
  body: Buffer;
  contentType: string;
}

interface Slot {
  page: Page;
  loadedKey: string | null;
  busy: boolean;
}

/** Bundled Inter (OFL) subsets, with their unicode ranges, from @fontsource-variable/inter. */
function interFonts(): Array<{ file: string; unicodeRange: string }> {
  const require = createRequire(import.meta.url);
  const cssPath = require.resolve("@fontsource-variable/inter/wght.css");
  const css = readFileSync(cssPath, "utf8");
  const out: Array<{ file: string; unicodeRange: string }> = [];
  for (const block of css.split("@font-face").slice(1)) {
    const src = /url\(\.\/files\/([^)]+\.woff2)\)/.exec(block)?.[1];
    const range = /unicode-range:\s*([^;]+);/.exec(block)?.[1];
    if (src && range) out.push({ file: join(dirname(cssPath), "files", src), unicodeRange: range.trim() });
  }
  return out;
}

function launchArgs(mode: DwConfig["renderMode"]): string[] {
  const common = ["--force-color-profile=srgb", "--font-render-hinting=none", "--disable-lcd-text", "--hide-scrollbars", "--mute-audio", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"];
  if (mode === "deterministic") return [...common, "--use-angle=swiftshader", "--use-gl=angle", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
  return [...common, "--enable-gpu", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"];
}

export interface ChromiumRendererOptions {
  config: DwConfig;
  /** Pages rendering in parallel. Default: config.maxConcurrentRenders. */
  poolSize?: number;
  debug?: boolean;
}

/**
 * Three.js running in headless Chromium. Node prepares textures (sharp) and sends plain JSON
 * (resolved scene + FrameState); the page draws and returns a PNG. No browser UI is ever shown.
 */
export class ThreeChromiumRenderer implements RenderBackend {
  readonly name = "three-chromium";
  readonly capabilities = CAPABILITIES;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private slots: Slot[] = [];
  private waiters: Array<(s: Slot) => void> = [];
  private readonly resources = new Map<string, Resource>();
  private readonly derived = new Map<string, string>();
  private fonts: PageFont[] = [];
  private pageLimits: PageLimits | null = null;
  private starting: Promise<void> | null = null;

  constructor(private readonly opts: ChromiumRendererOptions) {}

  static async launch(opts: ChromiumRendererOptions): Promise<ThreeChromiumRenderer> {
    const r = new ThreeChromiumRenderer(opts);
    await r.start();
    return r;
  }

  get limits(): PageLimits | null {
    return this.pageLimits;
  }

  /** Starts the browser on first use (so an idle MCP server costs nothing). */
  private start(): Promise<void> {
    if (!this.starting) {
      this.starting = this.doStart().catch((e) => {
        this.starting = null;
        throw e;
      });
    }
    return this.starting;
  }

  private async doStart(): Promise<void> {
    if (!existsSync(PAGE_JS)) {
      throw new DwError("RENDERER_NOT_BUILT", `Renderer page bundle missing at ${PAGE_JS}.`, { hint: "Run `pnpm build`." });
    }
    try {
      this.browser = await chromium.launch({
        headless: true,
        args: launchArgs(this.opts.config.renderMode),
        ...(this.opts.config.chromiumPath ? { executablePath: this.opts.config.chromiumPath } : {}),
      });
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      throw new DwError("CHROMIUM_MISSING", `Could not start headless Chromium: ${msg.split("\n")[0]}`, {
        hint: "Run `devicewrapper setup` to download it, or set DEVICEWRAPPER_CHROMIUM_PATH to a Chrome/Chromium executable.",
      });
    }
    this.context = await this.browser.newContext({ viewport: { width: 64, height: 64 }, deviceScaleFactor: 1, javaScriptEnabled: true, offline: false });
    await this.context.route("**/*", (route) => this.serve(route));
    this.fonts = interFonts().map((f) => ({ family: "Inter", url: this.register(readFileSync(f.file), "font/woff2"), unicodeRange: f.unicodeRange, weight: "100 900" }));
    const size = Math.max(1, this.opts.poolSize ?? this.opts.config.maxConcurrentRenders);
    for (let i = 0; i < size; i++) this.slots.push(await this.newSlot());
    this.pageLimits = await this.slots[0]!.page.evaluate(() => (globalThis as unknown as { dw: PageApi }).dw.limits());
  }

  private async newSlot(): Promise<Slot> {
    const page = await this.context!.newPage();
    page.on("console", (m) => {
      if (this.opts.debug || m.type() === "error") process.stderr.write(`[renderer page] ${m.type()}: ${m.text()}\n`);
    });
    page.on("pageerror", (e) => process.stderr.write(`[renderer page] error: ${e.message}\n`));
    await page.goto(`${ORIGIN}/index.html`);
    await page.waitForFunction(() => (globalThis as unknown as { dwReady?: boolean }).dwReady === true, undefined, { timeout: 30000 });
    return { page, loadedKey: null, busy: false };
  }

  private async serve(route: Route): Promise<void> {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort("blockedbyclient");
    if (url.pathname === "/index.html") return route.fulfill({ status: 200, contentType: "text/html", body: HTML });
    if (url.pathname === "/page.js") return route.fulfill({ status: 200, contentType: "text/javascript", body: readFileSync(PAGE_JS) });
    const res = this.resources.get(url.pathname);
    if (!res) return route.fulfill({ status: 404, body: "not found" });
    return route.fulfill({ status: 200, contentType: res.contentType, body: res.body });
  }

  /** Registers binary data for the page to fetch; content-addressed so repeats are free. */
  private register(body: Buffer, contentType: string): string {
    const path = `/r/${createHash("sha256").update(body).digest("hex").slice(0, 24)}`;
    if (!this.resources.has(path)) this.resources.set(path, { body, contentType });
    return `${ORIGIN}${path}`;
  }

  private async derive(key: string, make: () => Promise<Buffer>): Promise<string> {
    const hit = this.derived.get(key);
    if (hit) return hit;
    const url = this.register(await make(), "image/png");
    this.derived.set(key, url);
    return url;
  }

  /** Drops cached textures when the cache grows large; pages re-request what they need. */
  private trimResources(keep: Set<string>): void {
    let total = 0;
    for (const r of this.resources.values()) total += r.body.length;
    if (total < 768 * 1024 * 1024) return;
    for (const [path] of this.resources) {
      if (!keep.has(`${ORIGIN}${path}`) && !this.fonts.some((f) => f.url.endsWith(path))) this.resources.delete(path);
    }
    for (const [k, url] of this.derived) if (!keep.has(url)) this.derived.delete(k);
  }

  private async acquire(): Promise<Slot> {
    await this.start();
    const free = this.slots.find((s) => !s.busy);
    if (free) {
      free.busy = true;
      return free;
    }
    return new Promise<Slot>((res) => this.waiters.push(res));
  }

  private release(slot: Slot): void {
    const next = this.waiters.shift();
    if (next) next(slot);
    else slot.busy = false;
  }

  private async buildPayload(scene: ResolvedScene): Promise<LoadPayload> {
    const nodes: PageNode[] = [];
    const fonts: PageFont[] = [...this.fonts];
    for (const n of scene.nodes) {
      if (n.kind === "device") {
        const src = n.screen.source;
        const dev: PageNode = {
          kind: "device",
          id: n.id,
          ...(n.parent ? { parent: n.parent } : {}),
          castShadow: n.castShadow,
          receiveShadow: n.receiveShadow,
          def: n.def,
          bodyColor: n.bodyColor,
          finish: n.finish,
          ...(n.bodyMaterial ? { bodyMaterial: n.bodyMaterial } : {}),
          screenColor: src.type === "color" ? src.color : n.screen.background,
        };
        if (src.type === "image") {
          const asset = scene.assets[src.asset];
          if (!asset) throw new DwError("UNKNOWN_ASSET", `Screen of '${n.id}' references missing asset '${src.asset}'.`);
          const key = JSON.stringify(["screen", asset.hash ?? asset.absPath, n.screen, n.def.screen.pixels]);
          dev.screenUrl = await this.derive(key, () => prepareScreenTexture(asset.absPath, n.screen, n.def.screen.pixels));
        }
        nodes.push(dev);
      } else if (n.kind === "text2d") {
        nodes.push({ ...n });
      } else if (n.kind === "group") {
        nodes.push({ kind: "group", id: n.id, ...(n.parent ? { parent: n.parent } : {}), castShadow: n.castShadow, receiveShadow: n.receiveShadow });
      } else if (n.kind === "plane") {
        nodes.push({ kind: "plane", id: n.id, ...(n.parent ? { parent: n.parent } : {}), castShadow: n.castShadow, receiveShadow: n.receiveShadow, size: n.size, material: n.material });
      } else {
        nodes.push({
          kind: "primitive",
          id: n.id,
          ...(n.parent ? { parent: n.parent } : {}),
          castShadow: n.castShadow,
          receiveShadow: n.receiveShadow,
          shape: n.shape,
          size: n.size,
          cornerRadius: n.cornerRadius,
          material: n.material,
        });
      }
    }
    for (const [id, a] of Object.entries(scene.assets)) {
      if (a.type === "font") fonts.push({ family: id, url: this.register(readFileSync(a.absPath), "font/ttf") });
    }
    const cam = scene.scene.camera;
    return {
      key: scene.hash,
      cameraType: cam.type,
      near: cam.near,
      far: cam.far,
      environment: scene.environment,
      effects: scene.effects,
      lights: scene.scene.lights,
      nodes,
      fonts,
      seed: scene.seed,
    };
  }

  private async backgroundFor(scene: ResolvedScene, w: number, h: number): Promise<PageBackground> {
    const bg = scene.background;
    switch (bg.type) {
      case "solid":
        return { type: "solid", color: bg.color };
      case "gradient":
        return { type: "gradient", kind: bg.kind, angle: bg.angle, center: bg.center, radius: bg.radius, stops: bg.stops };
      case "transparent":
        return { type: "transparent" };
      case "image": {
        const asset = scene.assets[bg.asset];
        if (!asset) throw new DwError("UNKNOWN_ASSET", `Background references missing asset '${bg.asset}'.`);
        const key = JSON.stringify(["bg", asset.hash ?? asset.absPath, w, h, bg.fit, bg.color]);
        return { type: "image", url: await this.derive(key, () => prepareBackground(asset.absPath, w, h, bg.fit, bg.color)) };
      }
      case "video":
        // Video backgrounds arrive with video rendering; validation warns about this.
        return { type: "solid", color: "#000000" };
    }
  }

  /** Largest supersampling factor the GPU can take at this size (at least 1). */
  private effectiveSupersample(w: number, h: number, requested: number): number {
    const lim = this.pageLimits;
    if (!lim) return requested;
    const maxDim = Math.min(lim.maxRenderbufferSize, lim.maxViewport[0], lim.maxViewport[1], 16384);
    if (w > maxDim || h > maxDim) {
      throw new DwError("RESOLUTION_TOO_LARGE_FOR_RENDERER", `${w}x${h} exceeds the renderer's maximum drawable size of ${maxDim}px per side.`);
    }
    let ss = requested;
    while (ss > 1 && (w * ss > maxDim || h * ss > maxDim || w * h * ss * ss > 120_000_000)) ss--;
    return ss;
  }

  /** Draws one frame and returns a full-resolution PNG (before downscaling). */
  async renderRaw(scene: ResolvedScene, frame: FrameState, width: number, height: number, supersample: number, transparent: boolean, frameIndex = 0, signal?: AbortSignal): Promise<{ png: Buffer; scale: number }> {
    await this.start();
    const ss = this.effectiveSupersample(width, height, supersample);
    const bw = width * ss, bh = height * ss;
    const payload = await this.buildPayload(scene);
    const background = await this.backgroundFor(scene, bw, bh);
    if (signal?.aborted) throw new DwError("CANCELLED", "Render cancelled.");
    const slot = await this.acquire();
    try {
      if (slot.loadedKey !== payload.key) {
        await slot.page.evaluate((p) => (globalThis as unknown as { dw: PageApi }).dw.load(p), payload);
        slot.loadedKey = payload.key;
      }
      const opts: RenderFrameOptions = { width: bw, height: bh, scale: ss, transparent, frameIndex, background };
      const b64 = await slot.page.evaluate(([f, o]) => (globalThis as unknown as { dw: PageApi }).dw.render(f, o), [frame, opts] as const);
      const keep = new Set<string>(payload.nodes.flatMap((n) => (n.kind === "device" && n.screenUrl ? [n.screenUrl] : [])));
      if (background.type === "image") keep.add(background.url);
      this.trimResources(keep);
      return { png: Buffer.from(b64, "base64"), scale: ss };
    } catch (e) {
      if (e instanceof DwError) throw e;
      const msg = (e as Error).message ?? String(e);
      if (/Target (page|closed)|crash/i.test(msg)) {
        // Replace a crashed page so the next render works.
        const idx = this.slots.indexOf(slot);
        if (idx >= 0) this.slots[idx] = await this.newSlot();
      }
      throw new DwError("RENDER_FAILED", `The renderer failed: ${msg.split("\n")[0]}`, { hint: "Try a smaller size or supersample, or check the scene with validate_scene." });
    } finally {
      this.release(slot);
    }
  }

  async renderStill(scene: ResolvedScene, frame: FrameState, opts: StillOptions, signal?: AbortSignal): Promise<Buffer> {
    const { png, scale } = await this.renderRaw(scene, frame, opts.width, opts.height, opts.supersample, opts.transparent, 0, signal);
    let img = sharp(png);
    if (scale > 1) img = img.resize(opts.width, opts.height, { kernel: "lanczos3", fit: "fill" });
    switch (opts.format) {
      case "png":
        return img.png({ compressionLevel: 6, adaptiveFiltering: false }).toBuffer();
      case "jpeg":
        return img.flatten({ background: "#ffffff" }).jpeg({ quality: opts.quality, chromaSubsampling: opts.quality >= 90 ? "4:4:4" : "4:2:0", mozjpeg: true }).toBuffer();
      case "webp":
        return img.webp({ quality: opts.quality, alphaQuality: 100, smartSubsample: true }).toBuffer();
    }
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
    this.context = null;
    this.slots = [];
    this.starting = null;
  }
}
