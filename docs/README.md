# devicewrapper docs

| Doc | What's in it |
|---|---|
| [Using it in your projects](using.md) | Install, connect it to Claude Code or another MCP client, workspace and config, security model, CLI, library use |
| [Examples](examples.md) | Rendered gallery with the brief behind each image, plus prompts that work well |
| [MCP tools](tools.md) | Every tool with its description and parameters (generated) |
| [MCP resources](resources.md) | Resources and the agent guide (generated) |
| [Catalog](catalog.md) | Devices, templates, styles, layouts, motions, shots, lighting and canvas presets (generated) |
| [Scene format](scene-format.md) | The JSON scene model: every section, units, animation tracks, localization |
| [Templates and custom devices](templates.md) | Writing your own templates, styles and device models |
| [Rendering](rendering.md) | How pixels are made: pipeline, determinism, performance, video, transparency, effects |
| [Architecture](architecture.md) | Packages, data flow, design rules |
| [Tool-description eval](eval.md) | How the tool descriptions are tested with real agents, and what the last run found |

The generated docs are rebuilt with `pnpm build && pnpm run docs:gen`.
