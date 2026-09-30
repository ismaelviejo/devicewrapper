import { createReadStream, openSync, readSync, closeSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { extname } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import type { Asset } from "@devicewrapper/schema";
import { DwError } from "./errors.js";
import type { Workspace } from "./workspace.js";

const execFileAsync = promisify(execFile);

export type AssetType = Asset["type"];

interface Sniff {
  type: AssetType;
  format: string;
}

function head(path: string, n = 64): Buffer {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(n);
    const read = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** Identifies a file by its magic bytes (not just its extension). */
export function sniffFile(path: string): Sniff | null {
  const b = head(path, 512);
  const ascii = b.toString("latin1");
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47) return { type: "image", format: "png" };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: "image", format: "jpeg" };
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return { type: "image", format: "webp" };
  if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) return { type: "image", format: "gif" };
  const text = ascii.replace(/^﻿/, "").trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(text)) return { type: "image", format: "svg" };
  if (ascii.slice(4, 8) === "ftyp") {
    const brand = ascii.slice(8, 12);
    return { type: "video", format: brand === "qt  " ? "mov" : "mp4" };
  }
  if (b.length >= 4 && b.readUInt32BE(0) === 0x1a45dfa3) return { type: "video", format: "webm" };
  if (b.length >= 4 && (b.readUInt32BE(0) === 0x00010000 || ascii.startsWith("OTTO") || ascii.startsWith("true"))) {
    return { type: "font", format: ascii.startsWith("OTTO") ? "otf" : "ttf" };
  }
  if (ascii.startsWith("wOFF")) return { type: "font", format: "woff" };
  if (ascii.startsWith("wOF2")) return { type: "font", format: "woff2" };
  if (ascii.startsWith("glTF")) return { type: "model", format: "glb" };
  if (extname(path).toLowerCase() === ".gltf" && text.startsWith("{")) return { type: "model", format: "gltf" };
  return null;
}

export async function hashFile(path: string): Promise<string> {
  const h = createHash("sha256");
  await new Promise<void>((res, rej) => {
    createReadStream(path).on("data", (c) => h.update(c)).on("end", () => res()).on("error", rej);
  });
  return "sha256:" + h.digest("hex");
}

export interface VideoInfo {
  width: number;
  height: number;
  duration: number;
  fps: number;
}

export async function probeVideo(path: string, ffprobePath: string): Promise<VideoInfo> {
  let out: string;
  try {
    const r = await execFileAsync(
      ffprobePath,
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate,duration:format=duration", "-of", "json", path],
      { maxBuffer: 1 << 20, timeout: 30000 },
    );
    out = r.stdout;
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === "ENOENT") {
      throw new DwError("FFPROBE_MISSING", `ffprobe was not found at '${ffprobePath}'.`, {
        hint: "Install FFmpeg (it includes ffprobe) or set DEVICEWRAPPER_FFPROBE_PATH.",
      });
    }
    throw new DwError("VIDEO_PROBE_FAILED", `Could not read video ${path}: ${(err.stderr || err.message).trim()}`);
  }
  const j = JSON.parse(out) as { streams?: Array<Record<string, string | number>>; format?: { duration?: string } };
  const s = j.streams?.[0];
  if (!s) throw new DwError("VIDEO_PROBE_FAILED", `${path} has no video stream.`);
  const [num, den] = String(s.r_frame_rate ?? "30/1").split("/").map(Number);
  return {
    width: Number(s.width),
    height: Number(s.height),
    duration: Number(s.duration ?? j.format?.duration ?? 0),
    fps: den ? num! / den : num!,
  };
}

export interface ImportedAsset {
  asset: Asset;
  format: string;
}

/**
 * Inspects a file inside the workspace and returns an Asset record: type from magic bytes,
 * dimensions/duration probed, content hashed. The file is referenced in place, never copied.
 */
export async function inspectAsset(ws: Workspace, path: string, expected?: AssetType): Promise<ImportedAsset> {
  const abs = ws.resolveRead(path, "Asset");
  const st = statSync(abs);
  if (!st.isFile()) throw new DwError("NOT_A_FILE", `'${path}' is not a file.`);
  const sniff = sniffFile(abs);
  if (!sniff) {
    throw new DwError("UNSUPPORTED_ASSET", `'${path}' is not a supported file type.`, {
      hint: "Images: PNG, JPEG, WebP, SVG. Video: MP4, MOV, WebM. Fonts: TTF, OTF, WOFF, WOFF2. Models: GLB.",
    });
  }
  if (expected && sniff.type !== expected) {
    throw new DwError("ASSET_TYPE_MISMATCH", `'${path}' is a ${sniff.type} (${sniff.format}), not a ${expected}.`);
  }
  const limit = sniff.type === "video" ? ws.config.maxVideoBytes : ws.config.maxImageBytes;
  if (st.size > limit) {
    throw new DwError("ASSET_TOO_LARGE", `'${path}' is ${(st.size / 1048576).toFixed(1)} MB; the limit for ${sniff.type} assets is ${(limit / 1048576).toFixed(0)} MB.`);
  }
  const asset: Asset = { type: sniff.type, path: ws.toStoredPath(abs), bytes: st.size, hash: await hashFile(abs) };
  if (sniff.type === "image") {
    try {
      const meta = await sharp(abs, { limitInputPixels: 268402689 }).metadata();
      if (meta.width) asset.width = meta.width;
      if (meta.height) asset.height = meta.height;
    } catch (e) {
      throw new DwError("IMAGE_DECODE_FAILED", `'${path}' looks like ${sniff.format} but could not be decoded: ${(e as Error).message}`);
    }
  } else if (sniff.type === "video") {
    const v = await probeVideo(abs, ws.config.ffprobePath);
    asset.width = v.width;
    asset.height = v.height;
    asset.duration = v.duration;
    asset.fps = v.fps;
  }
  return { asset, format: sniff.format };
}

/**
 * Accepts either an existing asset ID or a workspace file path. Paths are inspected and registered
 * (reusing an existing asset that points at the same file). Returns the updated scene and the asset ID.
 */
export async function ensureAsset(
  ws: Workspace,
  scene: import("@devicewrapper/schema").Scene,
  ref: string,
  expected?: AssetType,
  preferredId?: string,
): Promise<{ scene: import("@devicewrapper/schema").Scene; assetId: string; imported: Asset | null }> {
  const existing = scene.assets[ref];
  if (existing) {
    if (expected && existing.type !== expected) {
      throw new DwError("ASSET_TYPE_MISMATCH", `Asset '${ref}' is a ${existing.type}, but a ${expected} is needed here.`);
    }
    return { scene, assetId: ref, imported: null };
  }
  const looksLikePath = /[\\/]/.test(ref) || /\.[a-zA-Z0-9]{2,5}$/.test(ref);
  if (!looksLikePath) {
    throw new DwError("UNKNOWN_ASSET", `'${ref}' is not an asset in scene '${scene.id}' and does not look like a file path.`, {
      hint: `Known assets: ${Object.keys(scene.assets).join(", ") || "(none)"}. Pass a workspace-relative path like 'screens/home.png' to import it.`,
    });
  }
  const { asset } = await inspectAsset(ws, ref, expected);
  const same = Object.entries(scene.assets).find(([, a]) => a.path === asset.path && a.hash === asset.hash);
  if (same) return { scene, assetId: same[0], imported: null };
  const { allocateId } = await import("./ids.js");
  const base = preferredId ?? asset.path.split("/").pop()!.replace(/\.[^.]+$/, "");
  if (preferredId && scene.assets[preferredId]) {
    throw new DwError("DUPLICATE_ID", `Asset ID '${preferredId}' already exists in scene '${scene.id}'.`);
  }
  const assetId = preferredId ?? allocateId(base, new Set(Object.keys(scene.assets)));
  const next = structuredClone(scene);
  next.assets[assetId] = asset;
  return { scene: next, assetId, imported: asset };
}
