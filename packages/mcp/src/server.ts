import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Engine } from "@devicewrapper/jobs";
import { INSTRUCTIONS } from "./guide.js";
import { registerResources } from "./resources.js";
import { registerAnimationTools } from "./tools/animation.js";
import { registerLookTools } from "./tools/look.js";
import { registerNodeTools } from "./tools/nodes.js";
import { registerRenderTools } from "./tools/render.js";
import { registerSceneTools } from "./tools/scene.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
export const MCP_VERSION = pkg.version;

/** Builds the MCP server over an engine. The server holds no state of its own. */
export function createMcpServer(engine: Engine): McpServer {
  const server = new McpServer(
    { name: "devicewrapper", title: "devicewrapper", version: MCP_VERSION },
    { instructions: INSTRUCTIONS, capabilities: { logging: {} } },
  );
  registerSceneTools(server, engine);
  registerNodeTools(server, engine);
  registerLookTools(server, engine);
  registerAnimationTools(server, engine);
  registerRenderTools(server, engine);
  registerResources(server, engine);
  return server;
}

/** Runs the server over stdio until the client disconnects. */
export async function runStdioServer(engine: Engine): Promise<void> {
  const server = createMcpServer(engine);
  const transport = new StdioServerTransport();
  const shutdown = async () => {
    await engine.close().catch(() => undefined);
    process.exit(0);
  };
  transport.onclose = () => void shutdown();
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  await server.connect(transport);
}
