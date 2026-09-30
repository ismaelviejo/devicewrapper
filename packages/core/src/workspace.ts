import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep, posix } from "node:path";
import { BUILTIN_ASSETS_DIR } from "./devices.js";
import { DwError } from "./errors.js";

export type RenderMode = "deterministic" | "fast";

export interface DwConfig {
  workspaceRoot: string;
  dataDir: string;
  outputDir: string;
  tmpDir: string;
  allowedRoots: string[];
  ffmpegPath: string;
  ffprobePath: string;
  chromiumPath?: string;
  renderMode: RenderMode;
  maxConcurrentRenders: number;
  maxWidth: number;
  maxHeight: number;
  maxDuration: number;
  maxImageBytes: number;
  maxVideoBytes: number;
}

type Env = Record<string, string | undefined>;

function realOrResolve(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

function int(v: string | undefined, fallback: number, name: string): number {
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new DwError("CONFIG_INVALID", `${name} must be a positive integer (got '${v}').`);
  return n;
}

/**
 * Configuration from env vars, then `<workspace>/.devicewrapper/config.json`, then defaults.
 * Env always wins. Nothing machine-specific is hardcoded.
 */
export function loadConfig(env: Env = process.env, cwd: string = process.cwd()): DwConfig {
  const workspaceRoot = realOrResolve(resolve(cwd, env.DEVICEWRAPPER_WORKSPACE ?? "."));
  const defaultData = join(workspaceRoot, ".devicewrapper");
  let file: Record<string, unknown> = {};
  const cfgPath = join(env.DEVICEWRAPPER_DATA_DIR ? resolve(workspaceRoot, env.DEVICEWRAPPER_DATA_DIR) : defaultData, "config.json");
  if (existsSync(cfgPath)) {
    try {
      file = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
    } catch (e) {
      throw new DwError("CONFIG_INVALID", `${cfgPath} is not valid JSON: ${(e as Error).message}`);
    }
  }
  const pick = (envKey: string, fileKey: string): string | undefined => {
    const v = env[envKey];
    if (v !== undefined && v !== "") return v;
    const f = file[fileKey];
    return f === undefined || f === null ? undefined : String(f);
  };
  const dataDir = resolve(workspaceRoot, pick("DEVICEWRAPPER_DATA_DIR", "dataDir") ?? defaultData);
  const extraRoots = (pick("DEVICEWRAPPER_ALLOWED_ROOTS", "allowedRoots") ?? "")
    .split(new RegExp(`[,${delimiter === ";" ? ";" : ":"}]`))
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => realOrResolve(resolve(workspaceRoot, p)));
  const [mw, mh] = (pick("DEVICEWRAPPER_MAX_RESOLUTION", "maxResolution") ?? "7680x4320").split("x").map(Number);
  const mode = pick("DEVICEWRAPPER_RENDER_MODE", "renderMode") ?? "deterministic";
  if (mode !== "deterministic" && mode !== "fast") {
    throw new DwError("CONFIG_INVALID", `DEVICEWRAPPER_RENDER_MODE must be 'deterministic' or 'fast' (got '${mode}').`);
  }
  if (!mw || !mh) throw new DwError("CONFIG_INVALID", "DEVICEWRAPPER_MAX_RESOLUTION must look like 3840x2160.");
  const chromium = pick("DEVICEWRAPPER_CHROMIUM_PATH", "chromiumPath");
  const cfg: DwConfig = {
    workspaceRoot,
    dataDir,
    outputDir: resolve(workspaceRoot, pick("DEVICEWRAPPER_OUTPUT_DIR", "outputDir") ?? join(dataDir, "output")),
    tmpDir: resolve(workspaceRoot, pick("DEVICEWRAPPER_TMP_DIR", "tmpDir") ?? join(dataDir, "tmp")),
    allowedRoots: [workspaceRoot, ...extraRoots],
    ffmpegPath: pick("DEVICEWRAPPER_FFMPEG_PATH", "ffmpegPath") ?? "ffmpeg",
    ffprobePath: pick("DEVICEWRAPPER_FFPROBE_PATH", "ffprobePath") ?? "ffprobe",
    renderMode: mode,
    maxConcurrentRenders: int(pick("DEVICEWRAPPER_MAX_CONCURRENT_RENDERS", "maxConcurrentRenders"), 2, "DEVICEWRAPPER_MAX_CONCURRENT_RENDERS"),
    maxWidth: mw,
    maxHeight: mh,
    maxDuration: Number(pick("DEVICEWRAPPER_MAX_DURATION_SECONDS", "maxDurationSeconds") ?? 120),
    maxImageBytes: int(pick("DEVICEWRAPPER_MAX_IMAGE_MB", "maxImageMB"), 100, "DEVICEWRAPPER_MAX_IMAGE_MB") * 1024 * 1024,
    maxVideoBytes: int(pick("DEVICEWRAPPER_MAX_VIDEO_MB", "maxVideoMB"), 2048, "DEVICEWRAPPER_MAX_VIDEO_MB") * 1024 * 1024,
  };
  if (chromium) cfg.chromiumPath = chromium;
  return cfg;
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The only way the engine touches the filesystem for user-controlled paths.
 * Reads: workspace, extra allowed roots, and the built-in assets dir.
 * Writes: workspace and extra allowed roots only.
 */
export class Workspace {
  readonly config: DwConfig;
  readonly root: string;
  readonly scenesDir: string;
  readonly jobsDir: string;
  readonly userDevicesDir: string;
  readonly userTemplatesDir: string;

  constructor(config: DwConfig) {
    this.config = config;
    this.root = config.workspaceRoot;
    this.scenesDir = join(config.dataDir, "scenes");
    this.jobsDir = join(config.dataDir, "jobs");
    this.userDevicesDir = join(config.dataDir, "devices");
    this.userTemplatesDir = join(config.dataDir, "templates");
  }

  ensureDirs(): void {
    for (const d of [this.config.dataDir, this.scenesDir, this.jobsDir, this.config.outputDir, this.config.tmpDir]) {
      mkdirSync(d, { recursive: true });
    }
  }

  private allowedRead(): string[] {
    return [...this.config.allowedRoots, realOrResolve(BUILTIN_ASSETS_DIR)];
  }

  private describeRoots(roots: string[]): string {
    return roots.join(", ");
  }

  /** Resolves a user path for reading. Relative paths are relative to the workspace root. Must exist. */
  resolveRead(p: string, what = "File"): string {
    if (typeof p !== "string" || p.length === 0 || p.includes("\0")) {
      throw new DwError("INVALID_PATH", `${what} path is empty or invalid.`);
    }
    const abs = resolve(this.root, p);
    if (!existsSync(abs)) {
      throw new DwError("FILE_NOT_FOUND", `${what} '${p}' does not exist. Looked for: ${abs}.`, {
        hint: `Relative paths resolve from the workspace root ${this.root}.`,
      });
    }
    const real = realpathSync(abs);
    if (!this.allowedRead().some((r) => isInside(real, r))) {
      throw new DwError("PATH_OUTSIDE_WORKSPACE", `${what} '${p}' resolves to ${real}, which is outside the allowed directories.`, {
        hint: `Allowed: ${this.describeRoots(this.allowedRead())}. Copy the file into the workspace, or add its folder to DEVICEWRAPPER_ALLOWED_ROOTS.`,
      });
    }
    return real;
  }

  /** Resolves a user path for writing. Parent directories are created. */
  resolveWrite(p: string, what = "Output"): string {
    if (typeof p !== "string" || p.length === 0 || p.includes("\0")) {
      throw new DwError("INVALID_PATH", `${what} path is empty or invalid.`);
    }
    const abs = resolve(this.root, p);
    // Walk up to the nearest existing ancestor and realpath it (defeats symlinked parents).
    let probe = dirname(abs);
    while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
    const realAncestor = realpathSync(probe);
    const finalPath = join(realAncestor, relative(probe, abs));
    if (!this.config.allowedRoots.some((r) => isInside(finalPath, r))) {
      throw new DwError("PATH_OUTSIDE_WORKSPACE", `${what} path '${p}' resolves to ${finalPath}, outside the writable directories.`, {
        hint: `Writable: ${this.describeRoots(this.config.allowedRoots)}.`,
      });
    }
    if (existsSync(finalPath)) {
      const real = realpathSync(finalPath);
      if (!this.config.allowedRoots.some((r) => isInside(real, r))) {
        throw new DwError("PATH_OUTSIDE_WORKSPACE", `${what} path '${p}' is a link to ${real}, outside the writable directories.`);
      }
    }
    mkdirSync(dirname(finalPath), { recursive: true });
    return finalPath;
  }

  /** Stores paths relative to the workspace root with '/' separators, so scenes are portable. */
  toStoredPath(abs: string): string {
    if (isInside(abs, this.root)) return relative(this.root, abs).split(sep).join(posix.sep);
    return abs;
  }

  /** Turns a workspace-relative display path into a short, readable form. */
  display(abs: string): string {
    return isInside(abs, this.root) ? relative(this.root, abs).split(sep).join("/") : abs;
  }
}
