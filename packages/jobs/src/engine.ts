import {
  DeviceRegistry,
  NO_RENDERER_CAPABILITIES,
  SceneStore,
  Workspace,
  loadConfig,
  validateScene,
  type DwConfig,
  type RenderBackend,
  type RendererCapabilities,
  type ValidationReport,
} from "@devicewrapper/core";
import { JobManager } from "./jobs.js";

export interface EngineOptions {
  config?: DwConfig;
  /** Renderer backend. Null = scene layer only (rendering tools report NOT_IMPLEMENTED). */
  backend?: RenderBackend | null;
}

/**
 * The engine facade shared by the MCP server, the CLI, and library users:
 * one workspace, one scene store, one device registry, one job queue.
 */
export class Engine {
  readonly config: DwConfig;
  readonly ws: Workspace;
  readonly store: SceneStore;
  readonly devices: DeviceRegistry;
  readonly jobs: JobManager;
  backend: RenderBackend | null;

  constructor(opts: EngineOptions = {}) {
    this.config = opts.config ?? loadConfig();
    this.ws = new Workspace(this.config);
    this.ws.ensureDirs();
    this.store = new SceneStore(this.ws);
    this.devices = DeviceRegistry.load([this.ws.userDevicesDir]);
    this.backend = opts.backend ?? null;
    this.jobs = new JobManager(this);
  }

  get capabilities(): RendererCapabilities {
    return this.backend?.capabilities ?? NO_RENDERER_CAPABILITIES;
  }

  validate(sceneOrInput: unknown): ValidationReport {
    return validateScene(sceneOrInput, {
      devices: this.devices,
      workspace: this.ws,
      ...(this.backend ? { capabilities: this.backend.capabilities } : {}),
    });
  }

  async close(): Promise<void> {
    await this.backend?.close();
  }
}
