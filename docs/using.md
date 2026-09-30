# Using devicewrapper in your projects

devicewrapper is an MCP server. You install it once, register it with your MCP client, and every project gets its own workspace for scenes and renders.

## 1. Install

You need Node 20+, pnpm and FFmpeg (only for video).

```bash
git clone https://github.com/ismaelviejo/devicewrapper.git ~/tools/devicewrapper
cd ~/tools/devicewrapper
pnpm install
pnpm build
pnpm setup          # downloads the headless Chromium used for rendering (~100 MB, once)
```

`pnpm setup` also checks for FFmpeg. On macOS, `brew install ffmpeg`. On Debian/Ubuntu, `apt install ffmpeg`.

The packages aren't on npm yet. Once they are, `npx -y devicewrapper mcp` will replace the path below (see [Publishing](#publishing)).

## 2. Connect it

### Claude Code

For every project on your machine:

```bash
claude mcp add --scope user devicewrapper -- node ~/tools/devicewrapper/packages/cli/dist/index.js mcp
```

For one project only, commit a `.mcp.json` at its root:

```json
{
  "mcpServers": {
    "devicewrapper": {
      "command": "node",
      "args": ["/Users/you/tools/devicewrapper/packages/cli/dist/index.js", "mcp"]
    }
  }
}
```

Use an absolute path: MCP clients don't expand `~` in `args`.

### Claude Desktop and other clients

Any MCP client that can start a stdio server works. The command is `node /path/to/devicewrapper/packages/cli/dist/index.js mcp`. Clients that don't start servers in your project directory need `DEVICEWRAPPER_WORKSPACE` in `env`:

```json
{
  "mcpServers": {
    "devicewrapper": {
      "command": "node",
      "args": ["/Users/you/tools/devicewrapper/packages/cli/dist/index.js", "mcp"],
      "env": { "DEVICEWRAPPER_WORKSPACE": "/Users/you/code/my-app" }
    }
  }
}
```

### Check it works

Ask your agent: *"List the devicewrapper templates."* It should call `list_templates`. Then try a real brief (see [examples](examples.md)).

## 3. The workspace

The workspace is the directory the server starts in (Claude Code starts it in your project), or `DEVICEWRAPPER_WORKSPACE`.

```
my-app/
  design/screens/home.png          your files, referenced in place by relative path
  .devicewrapper/
    config.json                    optional settings (below)
    scenes/<id>.json               saved scenes (canonical JSON, diff-friendly)
    jobs/                          render job records
    output/<sceneId>/…             default render output (render_preview writes preview.png here too)
    tmp/                           decoded video frames and other temporary files
    templates/*.json               your own templates (optional)
    devices/*.json                 your own device models (optional)
```

Commit `scenes/`, `templates/` and `devices/` if you want the mockups versioned with the app. Add `.devicewrapper/output/`, `.devicewrapper/jobs/` and `.devicewrapper/tmp/` to `.gitignore`.

Renders can also go anywhere in the workspace: pass `output: 'marketing/hero.png'` to `render`.

## 4. Configuration

Everything is optional. Environment variables win over `.devicewrapper/config.json`, which wins over defaults. [`.env.example`](../.env.example) lists them all.

| Env var | config.json key | Default | Meaning |
|---|---|---|---|
| `DEVICEWRAPPER_WORKSPACE` | – | current directory | Workspace root |
| `DEVICEWRAPPER_DATA_DIR` | `dataDir` | `<workspace>/.devicewrapper` | Scenes, jobs, previews |
| `DEVICEWRAPPER_OUTPUT_DIR` | `outputDir` | `<data>/output` | Default render output |
| `DEVICEWRAPPER_TMP_DIR` | `tmpDir` | `<data>/tmp` | Decoded video frames and other temp files |
| `DEVICEWRAPPER_ALLOWED_ROOTS` | `allowedRoots` | – | Extra folders the server may read from and write to (comma separated) |
| `DEVICEWRAPPER_FFMPEG_PATH` / `_FFPROBE_PATH` | `ffmpegPath` / `ffprobePath` | on `PATH` | FFmpeg binaries |
| `DEVICEWRAPPER_CHROMIUM_PATH` | `chromiumPath` | the one `setup` installed | Chromium executable |
| `DEVICEWRAPPER_RENDER_MODE` | `renderMode` | `deterministic` | `deterministic` (CPU, identical pixels everywhere) or `fast` (GPU if available) |
| `DEVICEWRAPPER_MAX_CONCURRENT_RENDERS` | `maxConcurrentRenders` | 2 | Parallel render jobs |
| `DEVICEWRAPPER_MAX_RESOLUTION` | `maxResolution` | `7680x4320` | Largest output |
| `DEVICEWRAPPER_MAX_DURATION_SECONDS` | `maxDurationSeconds` | 120 | Longest timeline |
| `DEVICEWRAPPER_MAX_IMAGE_MB` / `_VIDEO_MB` | `maxImageMB` / `maxVideoMB` | 100 / 2048 | Largest importable asset |

## 5. Security model

The server is meant to be driven by an agent, so it assumes tool arguments can't be trusted:

- Every path is resolved with `realpath` (symlinks followed) and must be inside the workspace or an allowed root; built-in assets are read-only. `../` tricks and symlinks out of the workspace fail with `PATH_OUTSIDE_WORKSPACE`.
- Assets are referenced by workspace-relative path; imported images are read with sharp and videos probed with ffprobe, and both are checked against the size limits.
- FFmpeg and ffprobe run with argument arrays built from enums and numbers, never a shell string.
- No tool accepts code, shaders, or scripts. The renderer page is a fixed bundle, and the headless browser can only reach a loopback server with a random secret path; every other host is blocked.

## 6. CLI

The same engine without an agent, handy for scripts and CI:

```bash
DW="node ~/tools/devicewrapper/packages/cli/dist/index.js"
$DW render hero -o hero.png                       # scene ID in the workspace, or a path to scene JSON
$DW render hero -o hero.jpg --width 2560 --locale es
$DW render launch -o launch.mp4 --width 1280      # .mp4 .webm .mov; progress on stderr
$DW render hero -o "store-{locale}.png" --locales en,es,ja
$DW validate hero
$DW scenes
$DW devices
```

## 7. As a library

```ts
import { composeScene, loadConfig } from "@devicewrapper/core";
import { Engine } from "@devicewrapper/jobs";
import { ThreeChromiumRenderer } from "@devicewrapper/renderer";

const config = loadConfig({ DEVICEWRAPPER_WORKSPACE: "/path/to/workspace" });
const engine = new Engine({ config, backend: new ThreeChromiumRenderer({ config }) });

const scene = await composeScene(engine.ws, engine.devices, {
  preset: "1080p",
  style: "dark-studio",
  devices: [{ model: "phone-modern", screen: "screens/home.png" }],
  text: [{ content: "Train smarter", position: "top" }],
}, "hero");
engine.store.save(scene);

const job = engine.jobs.create({ sceneId: "hero", format: "png", output: "renders/hero.png" });
const done = await engine.jobs.wait(job.jobId, 120_000);
console.log(done.status, done.output);
await engine.close();
```

All scene operations in `@devicewrapper/core` (`addNode`, `setCamera`, `applyLayout`, `applyMotion`, …) are pure `(scene, options) → scene` functions.

## 8. Docker

`docker/Dockerfile` builds a pinned render environment (Chromium, FFmpeg, Noto CJK and emoji fonts). Mount your project as the workspace:

```bash
docker build -f docker/Dockerfile -t devicewrapper .
docker run --rm -i -v "$PWD:/work" devicewrapper          # runs the MCP server on stdio; workspace = /work
```

## Publishing

The packages are ready to publish (`files`, `exports` and `bin` are set; the renderer ships its built page bundle, core ships its assets). You need an npm account with access to the `@devicewrapper` scope (or rename the scope), then:

```bash
pnpm build && pnpm test
pnpm -r publish --access public
```

pnpm replaces the `workspace:*` dependencies with real versions when it publishes. After that, other projects can use `npx -y devicewrapper mcp`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `RENDERER_NOT_BUILT` | Run `pnpm build` in the devicewrapper folder |
| `CHROMIUM_MISSING` or `CHROMIUM_START_FAILED` | Run `pnpm setup`, or set `DEVICEWRAPPER_CHROMIUM_PATH` |
| `FFMPEG_MISSING` / `FFPROBE_MISSING` on video | Install FFmpeg or set `DEVICEWRAPPER_FFMPEG_PATH` |
| `PATH_OUTSIDE_WORKSPACE` | The file is outside the workspace; move it in or add its folder to `DEVICEWRAPPER_ALLOWED_ROOTS` |
| A video job ends `INTERRUPTED` | The server stopped mid-render (client restarted it). Keep the client connected until the job completes |
| The first render takes 10–20 s | Normal: Chromium starts and shaders compile once per server |
