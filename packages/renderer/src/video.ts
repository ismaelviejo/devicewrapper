import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DwError, type AudioPlan, type VideoFormat } from "@devicewrapper/core";

/* ---------------------------------------------------------------- run */

function ffmpegMissing(path: string): DwError {
  return new DwError("FFMPEG_MISSING", `FFmpeg was not found at '${path}'. Video rendering needs it.`, {
    hint: "Install FFmpeg (brew install ffmpeg / apt install ffmpeg) or set DEVICEWRAPPER_FFMPEG_PATH.",
  });
}

function tail(s: string, lines = 6): string {
  return s.trim().split("\n").slice(-lines).join(" | ");
}

/** Runs ffmpeg with an argument array (never a shell) and resolves when it exits cleanly. */
export function runFfmpeg(ffmpegPath: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const child = spawn(ffmpegPath, ["-hide_banner", "-nostdin", "-loglevel", "error", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-8000);
    });
    child.on("error", (e: NodeJS.ErrnoException) => reject(e.code === "ENOENT" ? ffmpegMissing(ffmpegPath) : e));
    child.on("exit", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) reject(new DwError("CANCELLED", "Render cancelled."));
      else if (code === 0) resolve();
      else reject(new DwError("FFMPEG_FAILED", `FFmpeg failed (exit ${code}): ${tail(stderr)}`));
    });
  });
}

/* ------------------------------------------------------------- decode */

export interface DecodeSpec {
  absPath: string;
  /** Source dimensions (from the asset probe). */
  srcWidth: number;
  srcHeight: number;
  width: number;
  height: number;
  fps: number;
  fit: "cover" | "contain" | "fill";
  focus: [number, number];
  background: string;
  crop?: { x: number; y: number; width: number; height: number } | undefined;
  rotation?: 0 | 90 | 180 | 270;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** FFmpeg filter chain equivalent to the still-image fit (crop → rotate → fit → exact size). */
export function fitFilter(spec: DecodeSpec): string {
  const f: string[] = [`fps=${spec.fps}`];
  let sw = spec.srcWidth, sh = spec.srcHeight;
  if (spec.crop) {
    const cw = Math.max(2, Math.round(spec.crop.width * sw));
    const ch = Math.max(2, Math.round(spec.crop.height * sh));
    f.push(`crop=${cw}:${ch}:${Math.round(spec.crop.x * sw)}:${Math.round(spec.crop.y * sh)}`);
    sw = cw;
    sh = ch;
  }
  if (spec.rotation === 90) f.push("transpose=1");
  if (spec.rotation === 180) f.push("hflip,vflip");
  if (spec.rotation === 270) f.push("transpose=2");
  if (spec.rotation === 90 || spec.rotation === 270) [sw, sh] = [sh, sw];
  const { width: w, height: h } = spec;
  const color = spec.background.slice(1, 7);
  if (spec.fit === "fill") {
    f.push(`scale=${w}:${h}:flags=lanczos`);
  } else if (spec.fit === "contain") {
    const s = Math.min(w / sw, h / sh);
    const rw = Math.min(w, even(sw * s)), rh = Math.min(h, even(sh * s));
    f.push(`scale=${rw}:${rh}:flags=lanczos`, `pad=${w}:${h}:${Math.floor((w - rw) / 2)}:${Math.floor((h - rh) / 2)}:color=0x${color}`);
  } else {
    const s = Math.max(w / sw, h / sh);
    const rw = Math.max(w, Math.ceil(sw * s)), rh = Math.max(h, Math.ceil(sh * s));
    const x = Math.round((rw - w) * spec.focus[0]), y = Math.round((rh - h) * spec.focus[1]);
    f.push(`scale=${rw}:${rh}:flags=lanczos`, `crop=${w}:${h}:${x}:${y}`);
  }
  f.push("format=rgb24");
  return f.join(",");
}

export interface DecodedClip {
  dir: string;
  count: number;
}

/**
 * Decodes a clip into a JPEG frame sequence at the scene fps, fitted to the target size.
 * Cached in `dir` (keyed by the caller): an existing complete sequence is reused.
 */
export async function decodeClip(ffmpegPath: string, spec: DecodeSpec, dir: string, signal?: AbortSignal): Promise<DecodedClip> {
  const done = join(dir, ".complete");
  if (existsSync(done)) return { dir, count: readdirSync(dir).filter((f) => f.endsWith(".jpg")).length };
  const tmp = `${dir}.partial-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    await runFfmpeg(ffmpegPath, ["-i", spec.absPath, "-an", "-vf", fitFilter(spec), "-q:v", "2", "-start_number", "0", join(tmp, "%06d.jpg")], signal);
    const count = readdirSync(tmp).filter((f) => f.endsWith(".jpg")).length;
    if (count === 0) throw new DwError("VIDEO_DECODE_FAILED", `No frames could be decoded from ${spec.absPath}.`);
    writeFileSync(join(tmp, ".complete"), String(count));
    rmSync(dir, { recursive: true, force: true });
    renameSync(tmp, dir);
    return { dir, count };
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

/** Which decoded frame to show at timeline time t. */
export function clipFrameIndex(t: number, fps: number, count: number, offset: number, loop: boolean): number {
  const idx = Math.floor((t + offset) * fps + 1e-6);
  if (loop) return ((idx % count) + count) % count;
  return Math.min(count - 1, Math.max(0, idx));
}

/* ------------------------------------------------------------- encode */

/** Maps quality 1..100 to encoder settings. Higher quality = lower CRF. */
function crf(quality: number, best: number, worst: number): number {
  return Math.round(worst - ((worst - best) * (Math.min(100, Math.max(1, quality)) - 1)) / 99);
}

export function encoderArgs(format: VideoFormat, opts: { width: number; height: number; fps: number; quality: number; transparent: boolean; output: string }): string[] {
  const input = ["-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${opts.width}x${opts.height}`, "-framerate", String(opts.fps), "-i", "pipe:0"];
  const color = ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"];
  switch (format) {
    case "mp4":
      return [
        ...input,
        "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
        "-c:v", "libx264", "-preset", "medium", "-crf", String(crf(opts.quality, 12, 34)), "-profile:v", "high",
        ...color, "-movflags", "+faststart", "-threads", "0", "-y", opts.output,
      ];
    case "webm":
      return [
        ...input,
        "-vf", opts.transparent ? "format=yuva420p" : "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
        "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", String(crf(opts.quality, 15, 45)), "-deadline", "good", "-cpu-used", "2", "-row-mt", "1",
        ...(opts.transparent ? ["-auto-alt-ref", "0", "-metadata:s:v:0", "alpha_mode=1"] : color),
        "-y", opts.output,
      ];
    case "mov":
      return [
        ...input,
        "-c:v", "prores_ks", "-profile:v", "4", "-vendor", "apl0", "-bits_per_mb", String(Math.round(4000 + opts.quality * 40)),
        "-pix_fmt", opts.transparent ? "yuva444p10le" : "yuv444p10le",
        ...(opts.transparent ? [] : color),
        "-y", opts.output,
      ];
  }
}

/** A running ffmpeg encoder fed raw RGBA frames on stdin, with backpressure. */
export class FrameEncoder {
  private readonly child: ChildProcess;
  private stderr = "";
  private readonly exited: Promise<number | null>;
  private spawnError: Error | null = null;

  constructor(ffmpegPath: string, args: string[]) {
    this.child = spawn(ffmpegPath, ["-hide_banner", "-loglevel", "error", ...args], { stdio: ["pipe", "ignore", "pipe"] });
    this.child.stderr!.on("data", (d: Buffer) => {
      this.stderr = (this.stderr + d.toString()).slice(-8000);
    });
    this.child.stdin!.on("error", () => undefined);
    this.exited = new Promise((res) => {
      this.child.on("error", (e: NodeJS.ErrnoException) => {
        this.spawnError = e.code === "ENOENT" ? ffmpegMissing(ffmpegPath) : e;
        res(null);
      });
      this.child.on("exit", (code) => res(code));
    });
  }

  async write(frame: Buffer): Promise<void> {
    if (this.spawnError) throw this.spawnError;
    const stdin = this.child.stdin!;
    if (stdin.destroyed || this.child.exitCode !== null) {
      await this.exited;
      throw this.spawnError ?? new DwError("FFMPEG_FAILED", `FFmpeg stopped accepting frames: ${tail(this.stderr)}`);
    }
    if (!stdin.write(frame)) await new Promise<void>((res) => stdin.once("drain", () => res()));
  }

  async finish(): Promise<void> {
    this.child.stdin!.end();
    const code = await this.exited;
    if (this.spawnError) throw this.spawnError;
    if (code !== 0) throw new DwError("FFMPEG_FAILED", `FFmpeg failed while encoding (exit ${code}): ${tail(this.stderr)}`);
  }

  kill(): void {
    this.child.kill("SIGKILL");
  }
}

/* ------------------------------------------------------------- audio */

/**
 * FFmpeg arguments that add a mixed soundtrack to an already encoded (silent) video: every clip is
 * trimmed, resampled to 48 kHz stereo, scaled, delayed to its start, then mixed, padded/trimmed to the
 * exact video length and passed through a limiter so overlapping sounds never clip. The video stream
 * is copied, not re-encoded. Pure; argument arrays only.
 */
export function audioMuxArgs(format: VideoFormat, plan: AudioPlan, videoIn: string, output: string): string[] {
  const inputs: string[] = ["-i", videoIn];
  const chains: string[] = [];
  const labels: string[] = [];
  plan.clips.forEach((c, k) => {
    if (c.loop) inputs.push("-stream_loop", "-1");
    inputs.push("-i", c.file);
    const f = [
      `atrim=start=${num(c.skip)}`,
      "asetpts=PTS-STARTPTS",
      "aresample=48000",
      "aformat=sample_fmts=fltp:channel_layouts=stereo",
      `volume=${num(c.gain)}`,
    ];
    if (c.fadeIn && c.fadeIn > 0) f.push(`afade=t=in:st=0:d=${num(c.fadeIn)}`);
    if (c.fadeOut && c.fadeOut > 0) f.push(`afade=t=out:st=${num(Math.max(0, plan.duration - c.fadeOut))}:d=${num(Math.min(c.fadeOut, plan.duration))}`);
    if (c.loop) f.push(`atrim=end=${num(plan.duration)}`);
    const ms = Math.round(c.at * 1000);
    if (ms > 0) f.push(`adelay=${ms}:all=1`);
    chains.push(`[${k + 1}:a]${f.join(",")}[a${k}]`);
    labels.push(`[a${k}]`);
  });
  const mix =
    `${labels.join("")}amix=inputs=${labels.length}:normalize=0:dropout_transition=0,` +
    `apad=whole_dur=${num(plan.duration)},atrim=end=${num(plan.duration)},alimiter=limit=0.95:level=false[aout]`;
  const codec =
    format === "mp4" ? ["-c:a", "aac", "-b:a", "192k"] : format === "webm" ? ["-c:a", "libopus", "-b:a", "160k"] : ["-c:a", "pcm_s16le"];
  return [
    ...inputs,
    "-filter_complex", [...chains, mix].join(";"),
    "-map", "0:v", "-map", "[aout]",
    "-c:v", "copy", ...codec, "-ar", "48000",
    "-fflags", "+bitexact", "-flags:a", "+bitexact",
    ...(format === "mp4" ? ["-movflags", "+faststart"] : []),
    "-y", output,
  ];
}

/** Fixed-precision numbers for filter strings (no exponent notation, stable across runs). */
function num(v: number): string {
  return (Math.round(v * 1e6) / 1e6).toFixed(6).replace(/\.?0+$/, "") || "0";
}
