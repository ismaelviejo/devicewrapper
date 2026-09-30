import sharp, { type Sharp } from "sharp";
import type { Screen } from "@devicewrapper/schema";
import { DwError } from "@devicewrapper/core";

/** Largest texture edge we prepare. Keeps GPU memory sane while staying sharp at 4K output. */
const MAX_TEXTURE = 4096;

async function decode(absPath: string, want: [number, number]): Promise<Sharp> {
  const probe = sharp(absPath, { limitInputPixels: 268402689 });
  const meta = await probe.metadata();
  if (meta.format === "svg" && meta.width && meta.height) {
    // Rasterize vectors at the resolution we need, not their nominal size.
    const scale = Math.max(want[0] / meta.width, want[1] / meta.height, 1);
    return sharp(absPath, { density: Math.min(2400, Math.round(72 * scale)), limitInputPixels: 268402689 });
  }
  return sharp(absPath, { limitInputPixels: 268402689 });
}

interface FitSpec {
  fit: "cover" | "contain" | "fill";
  focus: [number, number];
  background: string;
  crop?: { x: number; y: number; width: number; height: number } | undefined;
  rotation?: 0 | 90 | 180 | 270;
}

/** Crops, rotates and fits an image to exactly width x height, flattened onto `background` (opaque RGB PNG). */
export async function fitImage(absPath: string, width: number, height: number, spec: FitSpec, keepAlpha = false): Promise<Buffer> {
  try {
    let img = await decode(absPath, [width, height]);
    img = img.rotate(); // honour EXIF orientation
    let buf = await img.png().toBuffer();
    let meta = await sharp(buf).metadata();
    let sw = meta.width!, sh = meta.height!;

    if (spec.crop) {
      const left = Math.min(sw - 1, Math.round(spec.crop.x * sw));
      const top = Math.min(sh - 1, Math.round(spec.crop.y * sh));
      const cw = Math.max(1, Math.min(sw - left, Math.round(spec.crop.width * sw)));
      const ch = Math.max(1, Math.min(sh - top, Math.round(spec.crop.height * sh)));
      buf = await sharp(buf).extract({ left, top, width: cw, height: ch }).png().toBuffer();
      sw = cw;
      sh = ch;
    }
    if (spec.rotation) {
      buf = await sharp(buf).rotate(spec.rotation).png().toBuffer();
      if (spec.rotation === 90 || spec.rotation === 270) [sw, sh] = [sh, sw];
    }

    let out: Sharp;
    if (spec.fit === "fill") {
      out = sharp(buf).resize(width, height, { fit: "fill", kernel: "lanczos3" });
    } else if (spec.fit === "contain") {
      out = sharp(buf).resize(width, height, { fit: "contain", kernel: "lanczos3", background: keepAlpha ? { r: 0, g: 0, b: 0, alpha: 0 } : spec.background });
    } else {
      const scale = Math.max(width / sw, height / sh);
      const rw = Math.max(width, Math.ceil(sw * scale));
      const rh = Math.max(height, Math.ceil(sh * scale));
      const resized = await sharp(buf).resize(rw, rh, { fit: "fill", kernel: "lanczos3" }).png().toBuffer();
      const left = Math.round((rw - width) * Math.min(1, Math.max(0, spec.focus[0])));
      const top = Math.round((rh - height) * Math.min(1, Math.max(0, spec.focus[1])));
      out = sharp(resized).extract({ left, top, width, height });
    }
    if (!keepAlpha) out = out.flatten({ background: spec.background });
    meta = await sharp(buf).metadata();
    return await out.toColourspace("srgb").png({ compressionLevel: 1 }).toBuffer();
  } catch (e) {
    throw new DwError("IMAGE_PROCESSING_FAILED", `Could not prepare image ${absPath}: ${(e as Error).message}`);
  }
}

/** Screen texture at the device's native pixel resolution (capped). */
export async function prepareScreenTexture(absPath: string, screen: Screen, pixels: [number, number]): Promise<Buffer> {
  let [w, h] = pixels;
  const longest = Math.max(w, h);
  if (longest > MAX_TEXTURE) {
    const s = MAX_TEXTURE / longest;
    w = Math.round(w * s);
    h = Math.round(h * s);
  }
  return fitImage(absPath, w, h, {
    fit: screen.fit,
    focus: screen.focus,
    background: screen.background,
    crop: screen.crop,
    rotation: screen.rotation,
  });
}

/** Background image fitted to the full render buffer. */
export async function prepareBackground(absPath: string, width: number, height: number, fit: "cover" | "contain" | "fill", color: string): Promise<Buffer> {
  return fitImage(absPath, width, height, { fit, focus: [0.5, 0.5], background: color });
}
