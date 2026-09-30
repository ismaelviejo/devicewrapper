#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { deviceSize, isDwError, loadConfig, type RenderBackend } from "@devicewrapper/core";
import { Engine } from "@devicewrapper/jobs";
import { runStdioServer } from "@devicewrapper/mcp";
import { loadBackend, renderCommand, setupCommand } from "./render.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

function fail(e: unknown): never {
  if (isDwError(e)) {
    console.error(`error ${e.code}: ${e.message}`);
    if (e.hint) console.error(`hint: ${e.hint}`);
  } else {
    console.error(`error: ${(e as Error)?.message ?? String(e)}`);
  }
  process.exit(1);
}

async function engineFor(opts: { workspace?: string; render?: boolean }): Promise<Engine> {
  const env = { ...process.env, ...(opts.workspace ? { DEVICEWRAPPER_WORKSPACE: resolve(opts.workspace) } : {}) };
  const config = loadConfig(env);
  let backend: RenderBackend | null = null;
  if (opts.render !== false) backend = await loadBackend(config);
  return new Engine({ config, backend });
}

const program = new Command()
  .name("devicewrapper")
  .description("Headless 3D device mockups for AI agents. The MCP server is the main interface; these commands are for development and scripting.")
  .version(pkg.version)
  .option("-w, --workspace <dir>", "Workspace root (default: DEVICEWRAPPER_WORKSPACE or the current directory)");

program
  .command("mcp")
  .alias("server")
  .description("Run the MCP server over stdio")
  .option("--no-render", "Scene tools only; don't start the renderer")
  .action(async (opts: { render: boolean }) => {
    try {
      const engine = await engineFor({ ...program.opts(), render: opts.render });
      await runStdioServer(engine);
    } catch (e) {
      fail(e);
    }
  });

program
  .command("validate")
  .argument("<scene>", "Scene JSON file or scene ID in the workspace")
  .description("Validate a scene and print errors and warnings")
  .option("--json", "Print the report as JSON")
  .action(async (target: string, opts: { json?: boolean }) => {
    try {
      const engine = await engineFor({ ...program.opts(), render: false });
      const input = target.endsWith(".json") ? JSON.parse(readFileSync(engine.ws.resolveRead(target, "Scene file"), "utf8")) : engine.store.load(target);
      const report = engine.validate(input);
      if (opts.json) console.log(JSON.stringify(report, null, 2));
      else {
        for (const i of [...report.errors, ...report.warnings]) console.log(`${i.severity.padEnd(7)} ${i.code.padEnd(24)} ${i.message}${i.path ? `  [${i.path}]` : ""}`);
        console.log(report.valid ? `valid (${report.warnings.length} warning(s))` : `invalid: ${report.errors.length} error(s)`);
      }
      process.exit(report.valid ? 0 : 1);
    } catch (e) {
      fail(e);
    }
  });

program
  .command("render")
  .argument("<scene>", "Scene JSON file or scene ID in the workspace")
  .description("Render a scene to an image or video")
  .requiredOption("-o, --output <file>", "Output path; the extension picks the format (.png .jpg .webp .mp4 .webm .mov)")
  .option("-t, --time <seconds>", "Still: timeline time", parseFloat)
  .option("--width <px>", "Output width", (v) => parseInt(v, 10))
  .option("--height <px>", "Output height", (v) => parseInt(v, 10))
  .option("--locale <code>", "Locale for text variables")
  .option("--locales <codes>", "Render once per locale, e.g. en,es,ja (adds -<locale> to the output name, or use {locale} in it)")
  .option("--supersample <n>", "Supersampling factor 1-4", (v) => parseInt(v, 10))
  .option("--transparent", "Transparent background")
  .option("--quality <n>", "JPEG/WebP/video quality 1-100", (v) => parseInt(v, 10))
  .action(async (target: string, opts: Record<string, unknown>) => {
    try {
      const engine = await engineFor(program.opts());
      await renderCommand(engine, target, opts);
      await engine.close();
      process.exit(0);
    } catch (e) {
      fail(e);
    }
  });

program
  .command("scenes")
  .description("List scenes in the workspace")
  .action(async () => {
    try {
      const engine = await engineFor({ ...program.opts(), render: false });
      for (const s of engine.store.list()) console.log(`${s.id.padEnd(28)} ${s.size.padEnd(10)} ${String(s.duration).padStart(5)}s  ${s.devices} device(s)  ${s.name ?? ""}`);
    } catch (e) {
      fail(e);
    }
  });

program
  .command("devices")
  .description("List device models and colors")
  .action(async () => {
    try {
      const engine = await engineFor({ ...program.opts(), render: false });
      for (const d of engine.devices.list()) {
        const [w, h, dep] = deviceSize(d).map((v) => (v * 1000).toFixed(1));
        console.log(`${d.id.padEnd(16)} ${d.category.padEnd(11)} ${w} x ${h} x ${dep} mm  colors: ${d.colors.map((c) => c.name).join(", ")}`);
      }
    } catch (e) {
      fail(e);
    }
  });

program
  .command("setup")
  .description("Download the headless Chromium used for rendering and check FFmpeg")
  .action(async () => {
    try {
      await setupCommand(loadConfig());
    } catch (e) {
      fail(e);
    }
  });

program.parseAsync(process.argv).catch(fail);
