import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { DeviceRegistry, loadConfig, type RenderBackend } from "@devicewrapper/core";
import { Engine } from "@devicewrapper/jobs";

export const devices = DeviceRegistry.load();

export function tmpWorkspace(): { root: string; cleanup: () => void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dw-test-")));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export function makeEngine(root: string, backend: RenderBackend | null = null, env: Record<string, string> = {}): Engine {
  const config = loadConfig({ DEVICEWRAPPER_WORKSPACE: root, ...env }, root);
  return new Engine({ config, backend });
}

/** Writes a simple synthetic "app screenshot" PNG (gradient header + blocks). */
export async function writeScreenshot(path: string, w = 1179, h = 2556, hue = "#4f7cff"): Promise<void> {
  mkdirSync(join(path, ".."), { recursive: true });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect width="100%" height="100%" fill="#f6f7fb"/>
    <rect width="100%" height="${Math.round(h * 0.32)}" fill="${hue}"/>
    <circle cx="${w / 2}" cy="${Math.round(h * 0.16)}" r="${Math.round(w * 0.14)}" fill="#ffffff" opacity="0.9"/>
    ${[0, 1, 2, 3, 4]
      .map((i) => `<rect x="${Math.round(w * 0.07)}" y="${Math.round(h * (0.38 + i * 0.11))}" width="${Math.round(w * 0.86)}" height="${Math.round(h * 0.085)}" rx="${Math.round(w * 0.04)}" fill="#ffffff" stroke="#e3e6ef" stroke-width="4"/>`)
      .join("")}
    <rect x="${Math.round(w * 0.07)}" y="${Math.round(h * 0.93)}" width="${Math.round(w * 0.86)}" height="${Math.round(h * 0.045)}" rx="${Math.round(w * 0.02)}" fill="${hue}"/>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(path);
}
