import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { DwError, migrateScene, parseScene, type DwConfig, type RenderBackend } from "@devicewrapper/core";
import type { Engine, RenderRequest } from "@devicewrapper/jobs";
import { ThreeChromiumRenderer, checkFfmpeg, installChromium } from "@devicewrapper/renderer";
import type { OutputFormat } from "@devicewrapper/schema";

/** The renderer starts lazily on the first render, so `devicewrapper mcp` launches instantly. */
export async function loadBackend(config: DwConfig): Promise<RenderBackend | null> {
  return new ThreeChromiumRenderer({ config, debug: process.env.DEVICEWRAPPER_DEBUG === "1" });
}

const FORMAT_BY_EXT: Record<string, OutputFormat> = {
  ".png": "png",
  ".jpg": "jpeg",
  ".jpeg": "jpeg",
  ".webp": "webp",
  ".mp4": "mp4",
  ".webm": "webm",
  ".mov": "mov",
};

export async function renderCommand(engine: Engine, target: string, opts: Record<string, unknown>): Promise<void> {
  const output = String(opts.output);
  const format = FORMAT_BY_EXT[extname(output).toLowerCase()];
  if (!format) throw new DwError("UNSUPPORTED_FORMAT", `Can't tell the format from '${output}'. Use .png, .jpg, .webp, .mp4, .webm or .mov.`);
  let sceneOverride;
  let sceneId = target;
  if (target.endsWith(".json")) {
    sceneOverride = parseScene(migrateScene(JSON.parse(readFileSync(engine.ws.resolveRead(target, "Scene file"), "utf8"))));
    sceneId = sceneOverride.id;
  }
  const locales = typeof opts.locales === "string" ? opts.locales.split(",").map((l) => l.trim()).filter(Boolean) : [typeof opts.locale === "string" ? opts.locale : undefined];
  for (const locale of locales) {
    let out = output;
    if (locale && locales.length > 1) out = output.includes("{locale}") ? output.replaceAll("{locale}", locale) : output.replace(/(\.[a-z0-9]+)$/i, `-${locale}$1`);
    const req: RenderRequest = { sceneId, format, output: out };
    if (typeof opts.time === "number") req.time = opts.time;
    if (typeof opts.width === "number") req.width = opts.width;
    if (typeof opts.height === "number") req.height = opts.height;
    if (locale) req.locale = locale;
    if (typeof opts.supersample === "number") req.supersample = opts.supersample;
    if (typeof opts.quality === "number") req.quality = opts.quality;
    if (opts.transparent) req.transparent = true;
    await runJob(engine, engine.jobs.create(req, sceneOverride));
  }
}

async function runJob(engine: Engine, job: ReturnType<Engine["jobs"]["create"]>): Promise<void> {
  for (const w of job.warnings) process.stderr.write(`warning: ${w.message}\n`);
  let last = -1;
  for (;;) {
    const j = await engine.jobs.wait(job.jobId, 1000);
    if (j.kind === "video" && j.progress !== last) {
      last = j.progress;
      process.stderr.write(`\r${j.frames.done}/${j.frames.total} frames (${j.progress}%)`);
    }
    if (j.status === "completed") {
      if (j.kind === "video") process.stderr.write("\n");
      console.log(`${j.output}  ${j.width}x${j.height}  ${j.durationMs}ms`);
      return;
    }
    if (j.status === "failed" || j.status === "cancelled") {
      throw new DwError(j.error?.code ?? "RENDER_FAILED", j.error?.message ?? `Render ${j.status}.`, j.error?.hint ? { hint: j.error.hint } : {});
    }
  }
}

export async function setupCommand(config: DwConfig): Promise<void> {
  console.log("Installing headless Chromium for rendering…");
  await installChromium((l) => console.log(l));
  const ff = await checkFfmpeg(config.ffmpegPath);
  console.log(ff ? `FFmpeg: ${ff}` : `FFmpeg not found at '${config.ffmpegPath}'. Stills work without it; video rendering needs it (install FFmpeg or set DEVICEWRAPPER_FFMPEG_PATH).`);
  console.log("Ready. Start the MCP server with: devicewrapper mcp");
}
