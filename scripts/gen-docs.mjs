// Generates docs/tools.md and docs/resources.md from the live MCP server, so they can't drift.
// Usage: pnpm build && pnpm run docs:gen
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CANVAS_PRESETS,
  DeviceRegistry,
  LAYOUTS,
  LIGHTING_PRESETS,
  MOTIONS,
  SHOT_PRESETS,
  STYLES,
  deviceSize,
  loadConfig,
  loadTemplates,
} from "@devicewrapper/core";
import { Engine } from "@devicewrapper/jobs";
import { createMcpServer } from "@devicewrapper/mcp";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = realpathSync(mkdtempSync(join(tmpdir(), "dw-docs-")));
const engine = new Engine({ config: loadConfig({ DEVICEWRAPPER_WORKSPACE: root }, root), backend: null });
const server = createMcpServer(engine);
const [a, b] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "docs", version: "0" });
await Promise.all([server.connect(a), client.connect(b)]);

const typeOf = (s) => {
  if (!s) return "any";
  if (s.enum) {
    const vals = s.enum.map((v) => JSON.stringify(v));
    return vals.length > 12 ? `${vals.slice(0, 4).join(" | ")} | … (${vals.length} values)` : vals.join(" | ");
  }
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (s.anyOf || s.oneOf) return [...new Set((s.anyOf ?? s.oneOf).map(typeOf))].join(" | ");
  const tuple = s.prefixItems ?? (Array.isArray(s.items) ? s.items : null);
  if (tuple) return `[${tuple.map(typeOf).join(", ")}]`;
  if (s.type === "object" && s.properties) {
    const req = new Set(s.required ?? []);
    const keys = Object.keys(s.properties).map((k) => (req.has(k) ? k : `${k}?`));
    return `{ ${keys.join(", ")} }`;
  }
  if (s.type === "array") {
    const inner = typeOf(s.items);
    return inner.includes(" | ") ? `(${inner})[]` : `${inner}[]`;
  }
  if (Array.isArray(s.type)) return s.type.join(" | ");
  return s.type ?? "object";
};
const cell = (t) => String(t ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

const { tools } = await client.listTools();
const groups = [
  ["Compose (start here)", ["compose_scene", "list_templates", "apply_layout", "apply_style", "apply_motion"]],
  ["Scenes", ["create_scene", "get_scene", "list_scenes", "update_scene", "duplicate_scene", "delete_scene", "validate_scene", "import_scene", "export_scene"]],
  ["Nodes and assets", ["add_device", "add_node", "update_node", "remove_node", "import_asset"]],
  ["Look", ["set_camera", "set_lights", "set_background", "set_effects", "set_variables"]],
  ["Animation", ["set_track", "remove_track"]],
  ["Rendering", ["render_preview", "render", "get_render_job", "list_render_jobs", "cancel_render_job"]],
];
const seen = new Set(groups.flatMap(([, n]) => n));
const rest = tools.map((t) => t.name).filter((n) => !seen.has(n));
if (rest.length) groups.push(["Other", rest]);

let md = `# MCP tools\n\n_Generated from the live server by \`pnpm run docs:gen\` — do not edit by hand._\n\n${tools.length} tools. Every tool returns JSON text; errors come back with \`isError: true\` and \`{ error: { code, message, path?, hint? } }\`.\n\n`;
for (const [title, names] of groups) md += `- **${title}:** ${names.map((n) => `[\`${n}\`](#${n})`).join(", ")}\n`;
for (const [title, names] of groups) {
  md += `\n## ${title}\n`;
  for (const name of names) {
    const t = tools.find((x) => x.name === name);
    if (!t) continue;
    md += `\n### ${t.name}\n\n`;
    const hints = Object.entries(t.annotations ?? {}).filter(([k, v]) => k.endsWith("Hint") && v).map(([k]) => k.replace(/Hint$/, ""));
    if (hints.length) md += `_${hints.join(", ")}_\n\n`;
    md += `${t.description}\n\n`;
    const props = Object.entries(t.inputSchema.properties ?? {});
    if (props.length) {
      const req = new Set(t.inputSchema.required ?? []);
      md += `| Parameter | Type | Required | Default | Description |\n|---|---|---|---|---|\n`;
      for (const [k, s] of props) {
        md += `| \`${k}\` | ${cell(typeOf(s))} | ${req.has(k) ? "yes" : ""} | ${s.default !== undefined ? `\`${cell(JSON.stringify(s.default))}\`` : ""} | ${cell(s.description)} |\n`;
      }
    } else md += `No parameters.\n`;
  }
}
writeFileSync(join(repo, "docs/tools.md"), md);

const { resources } = await client.listResources();
let rmd = `# MCP resources\n\n_Generated from the live server by \`pnpm run docs:gen\`._\n\n| URI | Name | Description |\n|---|---|---|\n`;
for (const r of resources) rmd += `| \`${r.uri}\` | ${cell(r.name)} | ${cell(r.description)} |\n`;
const guide = await client.readResource({ uri: "devicewrapper://guide" });
rmd += `\n## The guide (\`devicewrapper://guide\`)\n\nAgents read this first. Reproduced here:\n\n${guide.contents[0].text.replace(/^#/gm, "###")}\n`;
writeFileSync(join(repo, "docs/resources.md"), rmd);

// Catalog: everything that comes from data files.
const devices = DeviceRegistry.load();
const mm = (m) => Math.round(m * 1000);
let cmd = `# Catalog\n\n_Generated by \`pnpm run docs:gen\` from the data files in \`packages/core/assets\`._\n\n`;
cmd += `## Devices\n\n| Model | Form | Size (mm) | Colors | Description |\n|---|---|---|---|---|\n`;
for (const id of devices.ids()) {
  const d = devices.require(id);
  const [w, h, dep] = deviceSize(d);
  cmd += `| \`${id}\` | ${d.form} | ${mm(w)} × ${mm(h)} × ${mm(dep)} | ${d.colors.map((c) => c.name).join(", ")} | ${cell(d.description)} |\n`;
}
cmd += `\nAny hex color works too. Add models as JSON in \`.devicewrapper/devices/\` (same format as \`packages/core/assets/devices/*.json\`).\n`;
cmd += `\n## Templates\n\nUse with \`compose_scene { template, screens }\`. See [templates.md](templates.md) to write your own.\n\n| Template | Screens | Style | Description |\n|---|---|---|---|\n`;
for (const t of loadTemplates().values()) cmd += `| \`${t.name}\` | ${t.screens} | ${t.brief.style ?? ""} | ${cell(t.description)} |\n`;
cmd += `\n## Styles\n\n| Style | Lighting | Floor | Description |\n|---|---|---|---|\n`;
for (const [k, v] of Object.entries(STYLES)) cmd += `| \`${k}\` | ${v.lighting}${v.environment ? ` + ${v.environment.preset} env` : ""} | ${v.floor.type} | ${cell(v.description)} |\n`;
cmd += `\n## Layouts\n\n| Layout | Description |\n|---|---|\n`;
for (const [k, v] of Object.entries(LAYOUTS)) cmd += `| \`${k}\` | ${cell(v)} |\n`;
cmd += `\n## Motions\n\n| Motion | Kind | Description |\n|---|---|---|\n`;
for (const [k, v] of Object.entries(MOTIONS)) cmd += `| \`${k}\` | ${v.kind} | ${cell(v.description)} |\n`;
cmd += `\n## Camera shots\n\n| Shot | Description |\n|---|---|\n`;
for (const [k, v] of Object.entries(SHOT_PRESETS)) cmd += `| \`${k}\` | ${cell(v.description)} |\n`;
cmd += `\n## Lighting presets\n\n| Preset | Environment | Lights | Description |\n|---|---|---|---|\n`;
for (const [k, v] of Object.entries(LIGHTING_PRESETS)) cmd += `| \`${k}\` | ${v.environment.preset} | ${v.lights.map((l) => `${l.id} (${l.type})`).join(", ")} | ${cell(v.description)} |\n`;
cmd += `\n## Canvas presets\n\n| Preset | Size |\n|---|---|\n`;
for (const [k, [w, h]] of Object.entries(CANVAS_PRESETS)) cmd += `| \`${k}\` | ${w} × ${h} |\n`;
writeFileSync(join(repo, "docs/catalog.md"), cmd);

await client.close();
rmSync(root, { recursive: true, force: true });
console.log(`docs/tools.md: ${tools.length} tools; docs/resources.md: ${resources.length} resources`);
