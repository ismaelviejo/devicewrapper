// Bundles page/main.ts (Three.js scene builder) into dist/page/page.js for the headless browser.
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(join(root, "dist", "page"), { recursive: true });
await build({
  entryPoints: [join(root, "page", "main.ts")],
  outfile: join(root, "dist", "page", "page.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome120"],
  minify: true,
  sourcemap: false,
  legalComments: "none",
  logLevel: "warning",
});
