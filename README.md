# devicewrapper

Headless 3D device mockups for AI agents. An MCP server that lets Claude Code (or any MCP client) build scenes with phones and tablets, put your app screenshots on their screens, light and animate them, and render stills and videos. No UI.

> Status: Phase 1 of [PLAN.md](PLAN.md) — the scene format, engine and MCP server. Rendering arrives in Phase 2.

## Quick start

```bash
pnpm install
pnpm build
```

Register the server with Claude Code from the project you want mockups in:

```bash
cd ~/code/my-app
claude mcp add devicewrapper -- node /path/to/devicewrapper/packages/cli/dist/index.js mcp
```

Or commit a `.mcp.json` in that project:

```json
{
  "mcpServers": {
    "devicewrapper": {
      "command": "node",
      "args": ["/path/to/devicewrapper/packages/cli/dist/index.js", "mcp"]
    }
  }
}
```

The server's workspace is the directory it starts in (override with `DEVICEWRAPPER_WORKSPACE`). Scenes, job records and renders go in `<workspace>/.devicewrapper/`. Screenshots are referenced in place by workspace-relative path; the server can't read or write outside the workspace (see `.env.example` for extra roots).

Then ask Claude things like:

> Create a 1080p hero shot of a black phone showing `design/screens/home.png`, turned slightly right, on a soft light gradient.

## Packages

| Package | What it does |
|---|---|
| `@devicewrapper/schema` | Zod schemas for the scene format; JSON Schema export |
| `@devicewrapper/core` | Pure scene operations, validation, timeline evaluation, camera framing, workspace + scene store, assets |
| `@devicewrapper/jobs` | `Engine` facade and the render job queue |
| `@devicewrapper/mcp` | The MCP server: 26 tools + resources |
| `devicewrapper` (cli) | `devicewrapper mcp`, `validate`, `render`, `scenes`, `devices`, `setup` |

## CLI

```bash
devicewrapper mcp                 # MCP server over stdio
devicewrapper validate hero       # scene ID or path/to/scene.json
devicewrapper scenes
devicewrapper devices
```

## Development

```bash
pnpm build
pnpm typecheck
pnpm test
```

See [PLAN.md](PLAN.md) for the roadmap and [CLAUDE.md](CLAUDE.md) for the working rules.
