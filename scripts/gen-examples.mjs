// Renders the example gallery in docs/examples.md from the briefs below (synthetic screenshots).
// Usage: pnpm build && node scripts/gen-examples.mjs [name ...]
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

export const EXAMPLES = {
  "hero-dark": {
    note: "One phone, dark studio, headline.",
    brief: { preset: "1080p", style: "dark-studio", devices: [{ model: "phone-modern", color: "black", screen: "screens/workout.png" }], text: [{ content: "Train smarter", position: "top" }] },
  },
  "trio-glossy": {
    note: "Three phones in an arc on a glossy black table (reflective floor, softbox reflections).",
    brief: { preset: "1080p", style: "glossy-dark", layout: "arc", devices: [{ model: "phone-modern", screen: "screens/home.png" }, { model: "phone-modern", screen: "screens/workout.png" }, { model: "phone-modern", screen: "screens/stats.png" }] },
  },
  fan: {
    note: "Fan layout, square format, light studio.",
    brief: { preset: "square", style: "light-studio", layout: "fan", devices: [{ model: "phone-modern", color: "silver", screen: "screens/home.png" }, { model: "phone-modern", color: "silver", screen: "screens/workout.png" }, { model: "phone-modern", color: "silver", screen: "screens/stats.png" }] },
  },
  showcase: {
    note: "Laptop, tablet and phone together (showcase layout), white product look.",
    brief: { preset: "1080p", style: "product-white", layout: "showcase", devices: [{ model: "laptop-14", color: "silver", screen: "screens/dashboard.png" }, { model: "tablet", screen: "screens/tablet.png" }, { model: "phone-modern", screen: "screens/home.png" }] },
  },
  "watch-sunset": {
    note: "Watch and phone, sunset style and environment, bottom caption.",
    brief: { preset: "1080p", style: "sunset", layout: "row", devices: [{ model: "watch-45", screen: "screens/watch.png" }, { model: "phone-modern", color: "natural", screen: "screens/workout.png" }], text: [{ content: "Pulse — now on your wrist", position: "bottom" }] },
  },
  "stack-dof": {
    note: "Stacked phones with depth of field focused on the front one.",
    brief: { preset: "1080p", style: "soft-gradient", layout: "stack", camera: { focalLength: 85, dof: 0.5 }, devices: [{ model: "phone-modern", screen: "screens/stats.png" }, { model: "phone-modern", screen: "screens/workout.png" }, { model: "phone-modern", screen: "screens/home.png" }] },
  },
  "app-store": {
    note: "Template app-store-hero, portrait 6.9\" App Store size.",
    brief: { template: "app-store-hero", screens: ["screens/stats.png"], variables: { headline: "Your runs, beautifully tracked" } },
  },
  "laptop-reveal": {
    note: "Template laptop-reveal on glossy-dark: lid opens, screen wakes (frame at 3.5 s of the video).",
    brief: { template: "laptop-reveal", screens: ["screens/dashboard.png"], style: "glossy-dark" },
    time: 3.5,
  },
};

async function screenshot(path, w, h, hue, title) {
  const rows = [0, 1, 2, 3].map((i) => `<rect x="${w * 0.07}" y="${h * (0.38 + i * 0.13)}" width="${w * 0.86}" height="${h * 0.1}" rx="${w * 0.03}" fill="#fff" stroke="#e3e6ef" stroke-width="4"/>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#f6f7fb"/><rect width="100%" height="${Math.round(h * 0.3)}" fill="${hue}"/><text x="${w * 0.07}" y="${h * 0.2}" font-size="${Math.round(Math.min(w, h) * 0.08)}" font-family="sans-serif" font-weight="700" fill="#fff">${title}</text>${rows}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(path);
}

const only = process.argv.slice(2);
const ws = realpathSync(mkdtempSync(join(tmpdir(), "dw-examples-")));
mkdirSync(join(ws, "screens"));
await screenshot(join(ws, "screens/home.png"), 1179, 2556, "#ff6b3d", "Home");
await screenshot(join(ws, "screens/workout.png"), 1179, 2556, "#2bb673", "Workout");
await screenshot(join(ws, "screens/stats.png"), 1179, 2556, "#4f7cff", "Stats");
await screenshot(join(ws, "screens/dashboard.png"), 2880, 1800, "#6c4bff", "Dashboard");
await screenshot(join(ws, "screens/tablet.png"), 2048, 2732, "#e0457b", "Library");
await screenshot(join(ws, "screens/watch.png"), 416, 496, "#2bb673", "72");

const t = new StdioClientTransport({ command: process.execPath, args: [join(repo, "packages/cli/dist/index.js"), "mcp"], env: { ...process.env, DEVICEWRAPPER_WORKSPACE: ws }, stderr: "inherit" });
const c = new Client({ name: "examples", version: "0" });
await c.connect(t);
const call = async (name, args) => {
  const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
  const data = JSON.parse(r.content.find((p) => p.type === "text").text);
  if (r.isError) throw new Error(`${name}: ${JSON.stringify(data)}`);
  return data;
};
const briefs = {};
for (const [name, ex] of Object.entries(EXAMPLES)) {
  if (only.length && !only.includes(name)) continue;
  await call("compose_scene", { id: name, ...ex.brief });
  const r = await call("render", { sceneId: name, format: "jpeg", quality: 88, width: 1280, time: ex.time ?? 0, output: `out/${name}.jpg`, wait: 50 });
  let job = r.jobs[0];
  while (job.status === "queued" || job.status === "running") job = await call("get_render_job", { jobId: job.jobId, wait: 45 });
  if (job.status !== "completed") throw new Error(`${name}: ${JSON.stringify(job)}`);
  copyFileSync(join(ws, "out", `${name}.jpg`), join(repo, "docs/images", `${name}.jpg`));
  briefs[name] = ex.brief;
  console.log(name, job.durationMs, "ms");
}
await c.close();
rmSync(ws, { recursive: true, force: true });
if (!only.length) writeFileSync(join(repo, "docs/images/briefs.json"), JSON.stringify(briefs, null, 2) + "\n");
