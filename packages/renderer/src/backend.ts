import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import sharp from "sharp";
import {
  DwError,
  type DwConfig,
  type FrameState,
  type RenderBackend,
  type RendererCapabilities,
  type ResolvedAsset,
  type ResolvedScene,
  type StillOptions,
  type VideoOptions,
} from "@devicewrapper/core";
import type { LoadPayload, PageApi, PageBackground, PageFont, PageLimits, PageNode, RenderFrameOptions } from "./protocol.js";
import { prepareBackground, prepareScreenTexture } from "./textures.js";
import { FrameEncoder, clipFrameIndex, decodeClip, encoderArgs, type DecodeSpec } from "./video.js";

// Works from both dist/ (published) and src/ (tests): the bundle always lives in <package>/dist/page.
const PAGE_JS = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "page", "page.js");
const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:transparent}</style></head><body><script src="page.js"></script></body></html>`;

/** Video screens are decoded at most this large (longest side); plenty for a phone in a 4K frame. */
const MAX_VIDEO_SCREEN = 1600;

export const CAPABILITIES: RendererCapabilities = {
  backgrounds: ["solid", "gradient", "image", "video", "transparent"],
  screenSources: ["image", "video", "color"],
  effects: ["vignette", "fog", "grain"],
  depthOfField: false,
  text: true,
  video: true,
  fonts: ["Inter"],
  stillFormats: ["png", "jpeg", "webp"],
  videoFormats: ["mp4", "webm", "mov"],
};

interface Resource {
  body?: Buffer;
  file?: string;
  contentType: string;
}

interface Slot {
  page: Page;
  loadedKey: string | null;
  busy: boolean;
}

interface Clip {
  key: string;
  count: number;
  fps: number;
  loop: boolean;
  offset: number;
}

/** Decoded clips needed to draw one scene: per video screen, plus a video background. */
interface SceneClips {
  screens: Map<string, Clip>;
  background: Clip | null;
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
  // The page may only reach our loopback server: every other hostname fails to resolve.
  const common = ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", "--force-color-profile=srgb", "--font-render-hinting=none", "--disable-lcd-text", "--hide-scrollbars", "--mute-audio", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"];
  if (mode === "deterministic") return [...common, "--use-angle=swiftshader", "--use-gl=angle", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
  return [...common, "--enable-gpu", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"];
}

const sha = (v: unknown) => createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex").slice(0, 24);

export interface ChromiumRendererOptions {
  config: DwConfig;
  /** Pages rendering in parallel. Default: config.maxConcurrentRenders. */
  poolSize?: number;
  debug?: boolean;
}

/**
 * Three.js running in headless Chromium. Node prepares textures (sharp) and video frames (FFmpeg)
 * and sends plain JSON (resolved scene + FrameState); the page draws. No browser UI is ever shown.
 */
export class ThreeChromiumRenderer implements RenderBackend {
  readonly name = "three-chromium";
  readonly capabilities = CAPABILITIES;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private server: Server | null = null;
  /** http://127.0.0.1:<port>/<random secret>: only this process knows the secret path. */
  private origin = "";
  private slots: Slot[] = [];
  private waiters: Array<(s: Slot) => void> = [];
  private readonly resources = new Map<string, Resource>();
  private readonly derived = new Map<string, string>();
  private readonly uploads = new Map<string, { resolve: (b: Buffer) => void; reject: (e: Error) => void }>();
  private uploadCounter = 0;
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

  private get clipsDir(): string {
    return join(this.opts.config.tmpDir, "clips");
  }

  /* ------------------------------------------------------------- browser */

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
    await this.startServer();
    this.context = await this.browser.newContext({ viewport: { width: 64, height: 64 }, deviceScaleFactor: 1 });
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
    await page.goto(`${this.origin}/index.html${this.opts.debug ? "?debug" : ""}`);
    await page.waitForFunction(() => (globalThis as unknown as { dwReady?: boolean }).dwReady === true, undefined, { timeout: 30000 });
    return { page, loadedKey: null, busy: false };
  }

  /**
   * Loopback HTTP server for the page: our bundle, registered resources, decoded clip frames, and
   * raw frame uploads. Plain HTTP moves binary data far faster than DevTools-protocol interception.
   */
  private startServer(): Promise<void> {
    const secret = randomBytes(16).toString("hex");
    this.server = createServer((req, res) => {
      this.handle(req, res, `/${secret}`).catch((e: Error) => {
        res.writeHead(500).end(e.message);
      });
    });
    // Long renders keep one connection busy for minutes; don't let Node recycle sockets under Chromium.
    this.server.keepAliveTimeout = 120_000;
    this.server.headersTimeout = 130_000;
    this.server.requestTimeout = 0;
    return new Promise((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => {
        const addr = this.server!.address();
        if (!addr || typeof addr === "string") return reject(new Error("no server address"));
        this.origin = `http://127.0.0.1:${addr.port}/${secret}`;
        resolve();
      });
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse, prefix: string): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    if (!url.pathname.startsWith(prefix + "/")) {
      res.writeHead(404).end();
      return;
    }
    const path = url.pathname.slice(prefix.length);
    const send = (status: number, type: string, body: Buffer | string) => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store" }).end(body);
    };
    if (path === "/index.html") return send(200, "text/html", HTML);
    if (path === "/page.js") return send(200, "text/javascript", readFileSync(PAGE_JS));
    const upload = /^\/upload\/([a-z0-9-]+)$/.exec(path);
    if (upload && req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const pending = this.uploads.get(upload[1]!);
      if (!pending) return send(404, "text/plain", "no such upload");
      this.uploads.delete(upload[1]!);
      pending.resolve(Buffer.concat(chunks));
      return send(200, "text/plain", "ok");
    }
    const clip = /^\/clip\/([0-9a-f]{24})\/(\d{1,7})$/.exec(path);
    if (clip) {
      const file = join(this.clipsDir, clip[1]!, `${clip[2]!.padStart(6, "0")}.jpg`);
      if (!existsSync(file)) return send(404, "text/plain", "no such frame");
      return send(200, "image/jpeg", readFileSync(file));
    }
    const r = this.resources.get(path);
    if (!r) return send(404, "text/plain", "not found");
    return send(200, r.contentType, r.body ?? readFileSync(r.file!));
  }

  /** Registers binary data for the page to fetch; content-addressed so repeats are free. */
  private register(body: Buffer, contentType: string): string {
    const path = `/r/${createHash("sha256").update(body).digest("hex").slice(0, 24)}`;
    if (!this.resources.has(path)) this.resources.set(path, { body, contentType });
    return `${this.origin}${path}`;
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
    for (const r of this.resources.values()) total += r.body?.length ?? 0;
    if (total < 768 * 1024 * 1024) return;
    for (const [path] of this.resources) {
      if (!keep.has(`${this.origin}${path}`) && !this.fonts.some((f) => f.url.endsWith(path))) this.resources.delete(path);
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

  /* ---------------------------------------------------------------- clips */

  private async clip(asset: ResolvedAsset, spec: Omit<DecodeSpec, "absPath" | "srcWidth" | "srcHeight">, loop: boolean, offset: number, signal?: AbortSignal): Promise<Clip> {
    if (!asset.width || !asset.height) {
      throw new DwError("VIDEO_NOT_PROBED", `Video asset '${asset.id}' has no dimensions recorded.`, { hint: "Re-import it with import_asset." });
    }
    const full: DecodeSpec = { ...spec, absPath: asset.absPath, srcWidth: asset.width, srcHeight: asset.height };
    const key = sha(["clip-v1", asset.hash ?? asset.absPath, { ...full, absPath: undefined }]);
    mkdirSync(this.clipsDir, { recursive: true });
    const decoded = await decodeClip(this.opts.config.ffmpegPath, full, join(this.clipsDir, key), signal);
    return { key, count: decoded.count, fps: spec.fps, loop, offset };
  }

  private async sceneClips(scene: ResolvedScene, fps: number, outW: number, outH: number, signal?: AbortSignal): Promise<SceneClips> {
    const screens = new Map<string, Clip>();
    for (const n of scene.nodes) {
      if (n.kind !== "device" || n.screen.source.type !== "video") continue;
      const src = n.screen.source;
      const asset = scene.assets[src.asset];
      if (!asset) throw new DwError("UNKNOWN_ASSET", `Screen of '${n.id}' references missing asset '${src.asset}'.`);
      let [w, h] = n.def.screen.pixels;
      const s = Math.min(1, MAX_VIDEO_SCREEN / Math.max(w, h));
      w = Math.round((w * s) / 2) * 2;
      h = Math.round((h * s) / 2) * 2;
      screens.set(
        n.id,
        await this.clip(
          asset,
          { width: w, height: h, fps, fit: n.screen.fit, focus: n.screen.focus, background: n.screen.background, crop: n.screen.crop, rotation: n.screen.rotation },
          src.loop,
          src.offset,
          signal,
        ),
      );
    }
    let background: Clip | null = null;
    const bg = scene.background;
    if (bg.type === "video") {
      const asset = scene.assets[bg.asset];
      if (!asset) throw new DwError("UNKNOWN_ASSET", `Background references missing asset '${bg.asset}'.`);
      background = await this.clip(asset, { width: outW + (outW % 2), height: outH + (outH % 2), fps, fit: bg.fit, focus: [0.5, 0.5], background: bg.color }, bg.loop, bg.offset, signal);
    }
    return { screens, background };
  }

  private clipUrl(c: Clip, t: number): string {
    return `${this.origin}/clip/${c.key}/${clipFrameIndex(t, c.fps, c.count, c.offset, c.loop)}`;
  }

  /* -------------------------------------------------------------- payload */

  private async buildPayload(scene: ResolvedScene): Promise<LoadPayload> {
    const nodes: PageNode[] = [];
    const fonts: PageFont[] = [...this.fonts];
    for (const n of scene.nodes) {
      const base = { id: n.id, ...("parent" in n && n.parent ? { parent: n.parent } : {}) };
      if (n.kind === "device") {
        const src = n.screen.source;
        const dev: PageNode = {
          kind: "device",
          ...base,
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
        nodes.push({ kind: "group", ...base, castShadow: n.castShadow, receiveShadow: n.receiveShadow });
      } else if (n.kind === "plane") {
        nodes.push({ kind: "plane", ...base, castShadow: n.castShadow, receiveShadow: n.receiveShadow, size: n.size, material: n.material });
      } else {
        nodes.push({ kind: "primitive", ...base, castShadow: n.castShadow, receiveShadow: n.receiveShadow, shape: n.shape, size: n.size, cornerRadius: n.cornerRadius, material: n.material });
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

  private async staticBackground(scene: ResolvedScene, w: number, h: number): Promise<PageBackground> {
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
        return { type: "solid", color: bg.color };
    }
  }

  /* --------------------------------------------------------------- sizing */

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

  /**
   * Every page call has a deadline. A page that stops responding is replaced and the render fails
   * with a clear error, instead of a job that hangs forever.
   */
  private async withDeadline<T>(slot: Slot, what: string, ms: number, fn: () => Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DwError("RENDER_TIMEOUT", `The renderer page did not finish ${what} within ${Math.round(ms / 1000)} s; it was restarted.`, {
        hint: "Try again; if it repeats, render smaller (width, supersample) or set DEVICEWRAPPER_DEBUG=1 and report the log.",
      })), ms);
    });
    try {
      return await Promise.race([fn(), deadline]);
    } catch (e) {
      if (e instanceof DwError && e.code === "RENDER_TIMEOUT") await this.replaceSlotPage(slot);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  private async replaceSlotPage(slot: Slot): Promise<void> {
    const old = slot.page;
    await old.close({ runBeforeUnload: false }).catch(() => undefined);
    const fresh = await this.newSlot();
    slot.page = fresh.page;
    slot.loadedKey = null;
  }

  private async ensureLoaded(slot: Slot, payload: LoadPayload): Promise<void> {
    if (slot.loadedKey !== payload.key) {
      await this.withDeadline(slot, "loading the scene", 240_000, () => slot.page.evaluate((p) => (globalThis as unknown as { dw: PageApi }).dw.load(p), payload));
      slot.loadedKey = payload.key;
    }
  }

  private async pageRender(slot: Slot, frame: FrameState, opts: RenderFrameOptions): Promise<string> {
    return this.withDeadline(slot, `frame at t=${frame.time.toFixed(3)}s`, 180_000, () =>
      slot.page.evaluate(([f, o]) => (globalThis as unknown as { dw: PageApi }).dw.render(f, o), [frame, opts] as const),
    );
  }

  private async recover(slot: Slot, e: unknown): Promise<never> {
    if (e instanceof DwError) throw e;
    const msg = (e as Error).message ?? String(e);
    if (/Target (page|closed)|crash/i.test(msg)) await this.replaceSlotPage(slot);
    throw new DwError("RENDER_FAILED", `The renderer failed: ${msg.split("\n")[0]}`, { hint: "Try a smaller size or supersample, or check the scene with validate_scene." });
  }

  /* --------------------------------------------------------------- stills */

  async renderStill(scene: ResolvedScene, frame: FrameState, opts: StillOptions, signal?: AbortSignal): Promise<Buffer> {
    await this.start();
    const ss = this.effectiveSupersample(opts.width, opts.height, opts.supersample);
    const bw = opts.width * ss, bh = opts.height * ss;
    const payload = await this.buildPayload(scene);
    const clips = await this.sceneClips(scene, scene.canvas.fps, opts.width, opts.height, signal);
    const background = clips.background ? ({ type: "image", url: this.clipUrl(clips.background, frame.time) } as const) : await this.staticBackground(scene, bw, bh);
    const screenFrames = Object.fromEntries([...clips.screens].map(([id, c]) => [id, this.clipUrl(c, frame.time)]));
    if (signal?.aborted) throw new DwError("CANCELLED", "Render cancelled.");
    const slot = await this.acquire();
    let png: Buffer;
    try {
      await this.ensureLoaded(slot, payload);
      const b64 = await this.pageRender(slot, frame, { width: bw, height: bh, scale: ss, transparent: opts.transparent, frameIndex: Math.round(frame.time * scene.canvas.fps), background, screenFrames, output: "png" });
      png = Buffer.from(b64, "base64");
      const keep = new Set<string>(payload.nodes.flatMap((n) => (n.kind === "device" && n.screenUrl ? [n.screenUrl] : [])));
      if (background.type === "image") keep.add(background.url);
      this.trimResources(keep);
    } catch (e) {
      return this.recover(slot, e);
    } finally {
      this.release(slot);
    }
    let img = sharp(png);
    if (ss > 1) img = img.resize(opts.width, opts.height, { kernel: "lanczos3", fit: "fill" });
    switch (opts.format) {
      case "png":
        return img.png({ compressionLevel: 6, adaptiveFiltering: false }).toBuffer();
      case "jpeg":
        return img.flatten({ background: "#ffffff" }).jpeg({ quality: opts.quality, chromaSubsampling: opts.quality >= 90 ? "4:4:4" : "4:2:0", mozjpeg: true }).toBuffer();
      case "webp":
        return img.webp({ quality: opts.quality, alphaQuality: 100, smartSubsample: true }).toBuffer();
    }
  }

  /* ---------------------------------------------------------------- video */

  /** A promise for the raw frame the page will POST to /upload/<token>; fails if it never arrives. */
  private expectUpload(token: string): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.uploads.delete(token);
        reject(new DwError("RENDER_FAILED", "A rendered frame never arrived from the renderer page (timeout)."));
      }, 120_000);
      this.uploads.set(token, {
        resolve: (b) => {
          clearTimeout(timer);
          resolve(b);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  async renderVideo(scene: ResolvedScene, frameAt: (index: number) => FrameState, opts: VideoOptions, signal?: AbortSignal): Promise<void> {
    await this.start();
    if (opts.transparent && opts.format === "mp4") {
      throw new DwError("NO_ALPHA", "MP4 (H.264) can't store transparency.", { hint: "Use format 'webm' (VP9 alpha) or 'mov' (ProRes 4444) for transparent video." });
    }
    const { width: w, height: h, fps } = opts;
    const ss = this.effectiveSupersample(w, h, opts.supersample);
    const bw = w * ss, bh = h * ss;
    const payload = await this.buildPayload(scene);
    const clips = await this.sceneClips(scene, fps, w, h, signal);
    const staticBg = clips.background ? null : await this.staticBackground(scene, bw, bh);
    if (signal?.aborted) throw new DwError("CANCELLED", "Render cancelled.");

    rmSync(opts.outputPath, { force: true });
    const partial = `${opts.outputPath}.partial.${opts.format}`;
    const encoder = new FrameEncoder(this.opts.config.ffmpegPath, encoderArgs(opts.format, { width: w, height: h, fps, quality: opts.quality, transparent: opts.transparent, output: partial }));
    const slot = await this.acquire();
    const total = opts.endFrame - opts.startFrame;
    try {
      await this.ensureLoaded(slot, payload);
      // Pipelined: frame i+1 draws while frame i uploads; frames reach the encoder strictly in order.
      let inFlight: { index: number; data: Promise<Buffer> } | null = null;
      const flush = async (f: { index: number; data: Promise<Buffer> }) => {
        const rgba = await f.data;
        if (rgba.length !== w * h * 4) throw new DwError("RENDER_FAILED", `Frame ${f.index} has ${rgba.length} bytes, expected ${w * h * 4}.`);
        await encoder.write(rgba);
        opts.onProgress?.(f.index - opts.startFrame + 1, total);
      };
      for (let i = opts.startFrame; i < opts.endFrame; i++) {
        if (signal?.aborted) throw new DwError("CANCELLED", "Render cancelled.");
        const frame = frameAt(i);
        const token = `f${++this.uploadCounter}-${process.pid}`;
        const data = this.expectUpload(token);
        const background = clips.background ? ({ type: "image", url: this.clipUrl(clips.background, frame.time) } as const) : staticBg!;
        const screenFrames = Object.fromEntries([...clips.screens].map(([id, c]) => [id, this.clipUrl(c, frame.time)]));
        await this.pageRender(slot, frame, {
          width: bw,
          height: bh,
          scale: ss,
          transparent: opts.transparent,
          frameIndex: i,
          background,
          screenFrames,
          output: "rgba",
          outWidth: w,
          outHeight: h,
          uploadUrl: `${this.origin}/upload/${token}`,
        });
        if (inFlight) await flush(inFlight);
        inFlight = { index: i, data };
      }
      if (inFlight) await flush(inFlight);
      await encoder.finish();
      const { renameSync } = await import("node:fs");
      renameSync(partial, opts.outputPath);
    } catch (e) {
      encoder.kill();
      rmSync(partial, { force: true });
      for (const [k, u] of this.uploads) {
        u.reject(new Error("aborted"));
        this.uploads.delete(k);
      }
      if (e instanceof DwError) throw e;
      return this.recover(slot, e);
    } finally {
      this.release(slot);
    }
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = null;
    this.browser = null;
    this.context = null;
    this.slots = [];
    this.starting = null;
  }
}
