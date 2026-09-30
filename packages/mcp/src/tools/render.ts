import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DwError } from "@devicewrapper/core";
import type { Engine, RenderJob, RenderRequest } from "@devicewrapper/jobs";
import { OutputFormat } from "@devicewrapper/schema";
import { ok, wrap, type ToolResult } from "../result.js";
import { CANVAS_PRESETS, CanvasPreset, SceneId } from "../schemas.js";

function brief(job: RenderJob): Record<string, unknown> {
  return {
    jobId: job.jobId,
    status: job.status,
    progress: job.progress,
    kind: job.kind,
    format: job.format,
    locale: job.locale,
    size: `${job.width}x${job.height}`,
    frames: job.frames,
    output: job.output,
    ...(job.error ? { error: job.error } : {}),
    ...(job.warnings.length ? { warnings: job.warnings.map((w) => w.message) } : {}),
    ...(job.durationMs !== null ? { durationMs: job.durationMs } : {}),
  };
}

export function registerRenderTools(server: McpServer, engine: Engine): void {
  server.registerTool(
    "render_preview",
    {
      title: "Render preview",
      description: [
        "Render a small, fast still of the scene and return it as an image you can look at. Use it after every meaningful change to check",
        "composition, framing, lighting and screen content, then refine. Previews skip supersampling, so edges are slightly rougher than final renders.",
        "time picks the moment on the timeline (seconds). Also saved to <output>/<sceneId>/preview.png.",
      ].join("\n"),
      inputSchema: {
        sceneId: SceneId,
        time: z.number().min(0).optional().describe("Timeline time in seconds. Default: the scene's render.time (0)."),
        locale: z.string().optional(),
        size: z.number().int().min(128).max(1280).default(640).describe("Longest side in pixels."),
        transparent: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(async (a): Promise<ToolResult> => {
      const r = await engine.jobs.preview({
        sceneId: a.sceneId,
        maxSize: a.size,
        ...(a.time !== undefined ? { time: a.time } : {}),
        ...(a.locale ? { locale: a.locale } : {}),
        ...(a.transparent !== undefined ? { transparent: a.transparent } : {}),
      });
      const meta = {
        sceneId: a.sceneId,
        path: r.path,
        size: `${r.width}x${r.height}`,
        ...(r.warnings.length ? { warnings: r.warnings.map((w) => w.message) } : {}),
      };
      return {
        content: [
          { type: "image", data: r.png.toString("base64"), mimeType: "image/png" },
          { type: "text", text: JSON.stringify(meta, null, 2) },
        ],
        structuredContent: meta,
      };
    }),
  );

  server.registerTool(
    "render",
    {
      title: "Render",
      description: [
        "Render final output as a background job. Stills: png | jpeg | webp. Video: mp4 (H.264) | webm (VP9) | mov (ProRes 4444, supports alpha).",
        "Size defaults to the scene canvas; pass preset ('1080p', '4k', …) or width/height (aspect is kept if you pass only one).",
        "locales: ['en', 'es', 'fr'] renders one output per language (one job each).",
        "Returns job IDs immediately. `wait` (max 50 s) blocks until the jobs finish or the time runs out; stills usually finish in a few seconds.",
        "Videos take longer (roughly 0.3–1.5 s per frame on CPU rendering): poll get_render_job with wait: 45 until completed. Draft with supersample: 1 and a small width first.",
        "Otherwise poll get_render_job. Output paths are relative to the workspace. Default path: .devicewrapper/output/<sceneId>/<sceneId>[-<locale>].<ext>.",
        "Example: { sceneId: 'hero', format: 'png', preset: '4k', wait: 45 }",
      ].join("\n"),
      inputSchema: {
        sceneId: SceneId,
        format: OutputFormat.optional().describe("Default: the scene's render.format (png)."),
        preset: CanvasPreset.optional(),
        width: z.number().int().min(16).optional(),
        height: z.number().int().min(16).optional(),
        time: z.number().min(0).optional().describe("Stills: timeline time in seconds."),
        start: z.number().min(0).optional().describe("Video: start time, seconds."),
        end: z.number().min(0).optional().describe("Video: end time, seconds. Default: canvas.duration."),
        locale: z.string().optional(),
        locales: z.array(z.string()).optional().describe("Render once per locale."),
        transparent: z.boolean().optional(),
        supersample: z.number().int().min(1).max(4).optional().describe("Default: scene render.supersample (2)."),
        quality: z.number().int().min(1).max(100).optional(),
        output: z.string().optional().describe("Output path. With locales, include {locale} in it, e.g. 'out/hero-{locale}.png'."),
        wait: z.number().min(0).max(50).default(0).describe("Seconds (max 50) to wait for completion before returning. MCP clients time out at ~60s, so poll get_render_job for longer renders."),
      },
    },
    wrap(async (a) => {
      const locales = a.locales?.length ? a.locales : [a.locale];
      if (a.output && locales.length > 1 && !a.output.includes("{locale}")) {
        throw new DwError("OUTPUT_COLLISION", "Rendering several locales to one output path would overwrite files.", {
          hint: "Include {locale} in output, e.g. 'renders/hero-{locale}.png', or omit output.",
        });
      }
      let width = a.width;
      let height = a.height;
      if (a.preset && width === undefined && height === undefined) [width, height] = CANVAS_PRESETS[a.preset];
      const jobs: RenderJob[] = [];
      for (const locale of locales) {
        const req: RenderRequest = { sceneId: a.sceneId };
        if (a.format) req.format = a.format;
        if (width !== undefined) req.width = width;
        if (height !== undefined) req.height = height;
        if (a.time !== undefined) req.time = a.time;
        if (a.start !== undefined) req.start = a.start;
        if (a.end !== undefined) req.end = a.end;
        if (locale) req.locale = locale;
        if (a.transparent !== undefined) req.transparent = a.transparent;
        if (a.supersample !== undefined) req.supersample = a.supersample;
        if (a.quality !== undefined) req.quality = a.quality;
        if (a.output) req.output = a.output.replaceAll("{locale}", locale ?? "default");
        jobs.push(engine.jobs.create(req));
      }
      let final = jobs;
      if (a.wait > 0) {
        const deadline = Date.now() + a.wait * 1000;
        final = [];
        for (const j of jobs) final.push(await engine.jobs.wait(j.jobId, Math.max(0, deadline - Date.now())));
      }
      const unfinished = final.filter((j) => j.status === "queued" || j.status === "running").length;
      return ok({
        jobs: final.map(brief),
        ...(unfinished ? { next: "Poll get_render_job with each jobId (use its wait option) until status is completed." } : {}),
      });
    }),
  );

  server.registerTool(
    "get_render_job",
    {
      title: "Get render job",
      description: "Status of a render job: queued | running | completed | failed | cancelled, with progress %, frames and output path. `wait` (max 50 s) blocks until it finishes or the time runs out; call again while it is still running.",
      inputSchema: { jobId: z.string().min(1), wait: z.number().min(0).max(50).default(0).describe("Seconds (max 50) to block waiting for completion.") },
      annotations: { readOnlyHint: true },
    },
    wrap(async (a) => ok(brief(await engine.jobs.wait(a.jobId, a.wait * 1000)))),
  );

  server.registerTool(
    "list_render_jobs",
    {
      title: "List render jobs",
      description: "Recent render jobs, newest first, optionally for one scene.",
      inputSchema: { sceneId: SceneId.optional(), limit: z.number().int().min(1).max(100).default(20) },
      annotations: { readOnlyHint: true },
    },
    wrap(async (a) => ok({ jobs: engine.jobs.list({ ...(a.sceneId ? { sceneId: a.sceneId } : {}), limit: a.limit }).map(brief) })),
  );

  server.registerTool(
    "cancel_render_job",
    {
      title: "Cancel render job",
      description: "Cancel a queued or running render. Finished jobs are unaffected.",
      inputSchema: { jobId: z.string().min(1) },
      annotations: { destructiveHint: true },
    },
    wrap(async (a) => ok(brief(engine.jobs.cancel(a.jobId)))),
  );
}
