import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import PQueue from "p-queue";
import {
  DwError,
  evaluateFrame,
  frameCount,
  isDwError,
  resolveScene,
  validateScene,
  type IssueDetail,
  type RenderBackend,
  type StillFormat,
  type ValidationIssue,
  type VideoFormat,
} from "@devicewrapper/core";
import { STILL_FORMATS, VIDEO_FORMATS, type OutputFormat, type Scene } from "@devicewrapper/schema";
import type { Engine } from "./engine.js";

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface RenderRequest {
  sceneId: string;
  format?: OutputFormat;
  width?: number;
  height?: number;
  /** Still renders: timeline time in seconds. */
  time?: number;
  /** Video renders: sub-range of the timeline in seconds. */
  start?: number;
  end?: number;
  locale?: string;
  transparent?: boolean;
  supersample?: number;
  quality?: number;
  /** Output path (workspace-relative). Default: <outputDir>/<sceneId>/<sceneId>[-<locale>].<ext> */
  output?: string;
}

export interface RenderJob {
  jobId: string;
  status: JobStatus;
  progress: number;
  sceneId: string;
  kind: "still" | "video";
  format: OutputFormat;
  locale: string;
  width: number;
  height: number;
  frames: { done: number; total: number };
  output: string;
  outputAbs: string;
  error: IssueDetail | null;
  warnings: ValidationIssue[];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
}

/** Formats that can store an alpha channel. Others always render opaque. */
const ALPHA_FORMATS = new Set<OutputFormat>(["png", "webp", "webm", "mov"]);

const EXT: Record<OutputFormat, string> = { png: "png", jpeg: "jpg", webp: "webp", mp4: "mp4", webm: "webm", mov: "mov" };

export function isVideoFormat(f: string): f is VideoFormat {
  return (VIDEO_FORMATS as readonly string[]).includes(f);
}

interface Pending {
  job: RenderJob;
  scene: Scene;
  request: RenderRequest;
  abort: AbortController;
  done: Promise<void>;
  resolveDone: () => void;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Render job queue. Jobs snapshot the scene at creation, so later edits don't affect a queued render.
 * Job records are persisted in <dataDir>/jobs so status survives a server restart.
 */
export class JobManager {
  private readonly queue: PQueue;
  private readonly jobs = new Map<string, RenderJob>();
  private readonly pending = new Map<string, Pending>();
  private counter = 0;

  constructor(private readonly engine: Engine) {
    this.queue = new PQueue({ concurrency: engine.config.maxConcurrentRenders });
    this.loadPersisted();
  }

  private get backend(): RenderBackend {
    const b = this.engine.backend;
    if (!b) {
      throw new DwError("NOT_IMPLEMENTED", "Rendering is not available: no renderer backend is attached to this server.", {
        hint: "Run the server with the renderer enabled (the default `devicewrapper mcp`), and install Chromium with `devicewrapper setup`.",
      });
    }
    return b;
  }

  private jobFile(id: string): string {
    return join(this.engine.ws.jobsDir, `${id}.json`);
  }

  private persist(job: RenderJob): void {
    mkdirSync(this.engine.ws.jobsDir, { recursive: true });
    const f = this.jobFile(job.jobId);
    writeFileSync(`${f}.tmp`, JSON.stringify(job, null, 2));
    renameSync(`${f}.tmp`, f);
  }

  private loadPersisted(): void {
    const dir = this.engine.ws.jobsDir;
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
      try {
        const job = JSON.parse(readFileSync(join(dir, f), "utf8")) as RenderJob;
        if (job.status === "queued" || job.status === "running") {
          job.status = "failed";
          job.error = { code: "INTERRUPTED", message: "The render was interrupted because the server stopped before it finished.", hint: "Start it again with render." };
          job.finishedAt = nowIso();
          this.persist(job);
        }
        this.jobs.set(job.jobId, job);
      } catch {
        // Corrupt job files are ignored.
      }
    }
  }

  private newId(): string {
    const d = new Date();
    const pad = (n: number, w = 2) => String(n).padStart(w, "0");
    const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
    let id: string;
    do {
      id = `job-${stamp}-${++this.counter}`;
    } while (this.jobs.has(id));
    return id;
  }

  /** Resolves the concrete settings for a request against the scene defaults. */
  plan(scene: Scene, req: RenderRequest): Omit<RenderJob, "jobId" | "status" | "progress" | "error" | "warnings" | "createdAt" | "startedAt" | "finishedAt" | "durationMs"> {
    const format = req.format ?? scene.render.format;
    const kind = isVideoFormat(format) ? "video" : "still";
    const aspect = scene.canvas.width / scene.canvas.height;
    let width = req.width ?? (req.height ? Math.round(req.height * aspect) : scene.canvas.width);
    let height = req.height ?? (req.width ? Math.round(req.width / aspect) : scene.canvas.height);
    if (kind === "video") {
      width += width % 2;
      height += height % 2;
    }
    const cfg = this.engine.config;
    if (width > cfg.maxWidth || height > cfg.maxHeight || width < 16 || height < 16) {
      throw new DwError("INVALID_RESOLUTION", `Output ${width}x${height} is outside the allowed range (16x16 to ${cfg.maxWidth}x${cfg.maxHeight}).`);
    }
    const locale = req.locale ?? scene.defaultLocale;
    let total = 1;
    if (kind === "video") {
      const start = req.start ?? 0;
      const end = req.end ?? scene.canvas.duration;
      if (!(end > start)) throw new DwError("INVALID_RANGE", `Video range end (${end}s) must be after start (${start}s).`);
      total = Math.max(1, Math.round((end - start) * scene.canvas.fps));
    }
    const suffix = req.locale || Object.keys(scene.locales).length ? `-${locale}` : "";
    const defaultOut = join(this.engine.config.outputDir, scene.id, `${scene.id}${suffix}.${EXT[format]}`);
    const outputAbs = req.output ? this.engine.ws.resolveWrite(req.output, "Render output") : defaultOut;
    return {
      sceneId: scene.id,
      kind,
      format,
      locale,
      width,
      height,
      frames: { done: 0, total },
      output: this.engine.ws.display(outputAbs),
      outputAbs,
    };
  }

  private checkScene(scene: Scene, req: RenderRequest): ValidationIssue[] {
    const report = validateScene(scene, { devices: this.engine.devices, workspace: this.engine.ws, capabilities: this.backend.capabilities });
    if (!report.valid) {
      const first = report.errors.slice(0, 3).map((e) => e.message).join(" ");
      throw new DwError("VALIDATION_FAILED", `Scene '${scene.id}' has ${report.errors.length} error(s): ${first}`, {
        details: report.errors,
        hint: "Fix these (validate_scene lists them all) and render again.",
      });
    }
    if (req.locale && req.locale !== scene.defaultLocale && !scene.locales[req.locale]) {
      throw new DwError("UNKNOWN_LOCALE", `Scene '${scene.id}' has no locale '${req.locale}'. Locales: ${Object.keys(scene.locales).join(", ") || "(none)"}.`, {
        hint: "Add translations with set_variables({ locale, variables }).",
      });
    }
    return report.warnings;
  }

  /** Queues a render. Pass `sceneOverride` to render a scene that isn't saved in the store (e.g. a JSON file). */
  create(req: RenderRequest, sceneOverride?: Scene): RenderJob {
    const backend = this.backend;
    const scene = sceneOverride ?? this.engine.store.load(req.sceneId);
    const warnings = this.checkScene(scene, req);
    const plan = this.plan(scene, req);
    if (plan.kind === "video" && !backend.renderVideo) {
      throw new DwError("NOT_IMPLEMENTED", `Video rendering (${plan.format}) is not available in this renderer yet.`, {
        hint: `Render a still instead (format: ${STILL_FORMATS.join(" | ")}).`,
      });
    }
    if (!(plan.kind === "video" ? backend.capabilities.videoFormats : backend.capabilities.stillFormats).includes(plan.format)) {
      throw new DwError("UNSUPPORTED_FORMAT", `Format '${plan.format}' is not supported by the renderer.`);
    }
    if (req.transparent === true && !ALPHA_FORMATS.has(plan.format)) {
      throw new DwError("NO_ALPHA", `Format '${plan.format}' can't store transparency.`, {
        hint: "Use png or webp for stills, webm (VP9 alpha) or mov (ProRes 4444) for video.",
      });
    }
    if (req.transparent !== true && !ALPHA_FORMATS.has(plan.format) && (scene.render.transparent || scene.background.type === "transparent")) {
      warnings.push({
        severity: "warning",
        code: "NO_ALPHA",
        message: `The scene has a transparent background, but ${plan.format} can't store alpha; it will render on ${plan.format === "jpeg" ? "white" : "black"}.`,
      });
    }
    const job: RenderJob = {
      ...plan,
      jobId: this.newId(),
      status: "queued",
      progress: 0,
      error: null,
      warnings,
      createdAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      durationMs: null,
    };
    this.jobs.set(job.jobId, job);
    this.persist(job);
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    const p: Pending = { job, scene, request: req, abort: new AbortController(), done, resolveDone };
    this.pending.set(job.jobId, p);
    const snapshot = { ...job, frames: { ...job.frames } };
    void this.queue.add(() => this.run(p));
    return snapshot;
  }

  private async run(p: Pending): Promise<void> {
    const { job, scene, request } = p;
    try {
      if (p.abort.signal.aborted) return;
      job.status = "running";
      job.startedAt = nowIso();
      this.persist(job);
      const t0 = performance.now();
      const resolved = resolveScene(scene, {
        devices: this.engine.devices,
        locale: job.locale,
        resolveAssetPath: (path) => this.engine.ws.resolveRead(path, "Asset"),
      });
      const supersample = request.supersample ?? scene.render.supersample;
      const transparent = ALPHA_FORMATS.has(job.format) && (request.transparent ?? (scene.render.transparent || scene.background.type === "transparent"));
      const quality = request.quality ?? scene.render.quality;
      mkdirSync(dirname(job.outputAbs), { recursive: true });
      if (job.kind === "still") {
        const time = request.time ?? scene.render.time;
        const buf = await this.backend.renderStill(
          resolved,
          evaluateFrame(scene, time),
          { width: job.width, height: job.height, supersample, transparent, format: job.format as StillFormat, quality },
          p.abort.signal,
        );
        writeFileSync(job.outputAbs, buf);
        job.frames.done = 1;
      } else {
        const fps = scene.canvas.fps;
        const start = Math.round((request.start ?? 0) * fps);
        await this.backend.renderVideo!(
          resolved,
          (i) => evaluateFrame(scene, i / fps),
          {
            width: job.width,
            height: job.height,
            supersample,
            transparent,
            format: job.format as VideoFormat,
            quality,
            fps,
            startFrame: start,
            endFrame: start + job.frames.total,
            outputPath: job.outputAbs,
            onProgress: (done, total) => {
              job.frames = { done, total };
              job.progress = Math.round((done / total) * 1000) / 10;
              if (done % Math.max(1, Math.round(fps)) === 0) this.persist(job);
            },
          },
          p.abort.signal,
        );
      }
      if (p.abort.signal.aborted) throw new DwError("CANCELLED", "Render cancelled.");
      job.status = "completed";
      job.progress = 100;
      job.durationMs = Math.round(performance.now() - t0);
    } catch (e) {
      if (p.abort.signal.aborted) {
        job.status = "cancelled";
        job.error = null;
      } else {
        job.status = "failed";
        job.error = isDwError(e) ? e.toJSON() : { code: "RENDER_FAILED", message: `Render failed: ${(e as Error).message ?? String(e)}` };
      }
    } finally {
      job.finishedAt = job.finishedAt ?? nowIso();
      this.persist(job);
      this.pending.delete(job.jobId);
      p.resolveDone();
    }
  }

  get(jobId: string): RenderJob {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new DwError("UNKNOWN_JOB", `No render job '${jobId}'.`, { hint: "list_render_jobs shows recent jobs." });
    }
    return { ...job, frames: { ...job.frames } };
  }

  /** Waits up to timeoutMs for a job to finish, then returns its current state. */
  async wait(jobId: string, timeoutMs: number): Promise<RenderJob> {
    this.get(jobId);
    const p = this.pending.get(jobId);
    if (p && timeoutMs > 0) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([p.done, new Promise<void>((r) => (timer = setTimeout(r, timeoutMs)))]);
      if (timer) clearTimeout(timer);
    }
    return this.get(jobId);
  }

  list(opts: { sceneId?: string; limit?: number } = {}): RenderJob[] {
    let all = [...this.jobs.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.jobId.localeCompare(a.jobId)));
    if (opts.sceneId) all = all.filter((j) => j.sceneId === opts.sceneId);
    return all.slice(0, opts.limit ?? 20).map((j) => ({ ...j }));
  }

  cancel(jobId: string): RenderJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new DwError("UNKNOWN_JOB", `No render job '${jobId}'.`);
    const p = this.pending.get(jobId);
    if (!p) return { ...job };
    p.abort.abort();
    if (job.status === "queued") {
      job.status = "cancelled";
      job.finishedAt = nowIso();
      this.persist(job);
    }
    return { ...job };
  }

  /** Render a small still synchronously (outside the queue) for fast visual feedback. */
  async preview(req: RenderRequest & { maxSize?: number }): Promise<{ png: Buffer; path: string; width: number; height: number; warnings: ValidationIssue[] }> {
    const backend = this.backend;
    const scene = this.engine.store.load(req.sceneId);
    const warnings = this.checkScene(scene, req);
    const max = req.maxSize ?? 640;
    const aspect = scene.canvas.width / scene.canvas.height;
    const width = aspect >= 1 ? max : Math.round(max * aspect);
    const height = aspect >= 1 ? Math.round(max / aspect) : max;
    const locale = req.locale ?? scene.defaultLocale;
    const resolved = resolveScene(scene, {
      devices: this.engine.devices,
      locale,
      resolveAssetPath: (path) => this.engine.ws.resolveRead(path, "Asset"),
    });
    const time = req.time ?? scene.render.time;
    const png = await backend.renderStill(resolved, evaluateFrame(scene, time), {
      width,
      height,
      supersample: 1,
      transparent: req.transparent ?? (scene.render.transparent || scene.background.type === "transparent"),
      format: "png",
      quality: 90,
    });
    const path = join(this.engine.config.outputDir, scene.id, "preview.png");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, png);
    return { png, path: this.engine.ws.display(path), width, height, warnings };
  }

  frameCountFor(scene: Scene): number {
    return frameCount(scene.canvas.duration, scene.canvas.fps);
  }

  async idle(): Promise<void> {
    await this.queue.onIdle();
  }
}
