import { DwError, type DwConfig, type RenderBackend } from "@devicewrapper/core";
import type { Engine } from "@devicewrapper/jobs";

/** Phase 1: no renderer yet. The scene layer and MCP server work; rendering reports NOT_IMPLEMENTED. */
export async function loadBackend(_config: DwConfig): Promise<RenderBackend | null> {
  return null;
}

export async function renderCommand(_engine: Engine, _target: string, _opts: Record<string, unknown>): Promise<void> {
  throw new DwError("NOT_IMPLEMENTED", "Rendering arrives in Phase 2.");
}

export async function setupCommand(_config: DwConfig): Promise<void> {
  console.log("Nothing to set up yet: rendering arrives in Phase 2.");
}
