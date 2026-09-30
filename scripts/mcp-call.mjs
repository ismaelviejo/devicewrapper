// Call one devicewrapper MCP tool from the shell (for debugging and agent evals).
// Usage: node scripts/mcp-call.mjs <workspace> <tool> '<json args>'
// Each call starts a fresh server, so video jobs longer than `wait` are interrupted; use it for
// stills and short clips, or keep a real MCP client connected for long renders.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [ws, tool, json = "{}"] = process.argv.slice(2);
if (!ws || !tool) {
  console.error("Usage: node scripts/mcp-call.mjs <workspace> <tool> '<json args>'");
  process.exit(2);
}
const cli = join(dirname(fileURLToPath(import.meta.url)), "../packages/cli/dist/index.js");
const t = new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], env: { ...process.env, DEVICEWRAPPER_WORKSPACE: ws }, stderr: "ignore" });
const c = new Client({ name: "mcp-call", version: "0" });
await c.connect(t);
const r = await c.callTool({ name: tool, arguments: JSON.parse(json) }, undefined, { timeout: 300000 });
for (const part of r.content) {
  if (part.type === "text") console.log(part.text);
  else if (part.type === "image") console.log(`[image ${part.mimeType}, ${Math.round((part.data.length * 0.75) / 1024)} KB]`);
}
// A call log in the workspace makes agent evals easy to score (calls, errors per brief).
appendFileSync(join(ws, ".calls.jsonl"), JSON.stringify({ tool, args: JSON.parse(json), isError: r.isError === true }) + "\n");
await c.close();
process.exit(r.isError ? 1 : 0);
