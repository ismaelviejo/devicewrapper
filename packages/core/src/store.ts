import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Id, SCHEMA_VERSION, type Scene } from "@devicewrapper/schema";
import { canonicalStringify, hashValue } from "./canonical.js";
import { DwError } from "./errors.js";
import { allocateId } from "./ids.js";
import { parseScene } from "./ops.js";
import type { Workspace } from "./workspace.js";

/** Upgrades older scene JSON to the current schema version. */
export function migrateScene(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new DwError("SCHEMA_INVALID", "A scene must be a JSON object.");
  }
  const obj = { ...(raw as Record<string, unknown>) };
  const v = obj.schemaVersion ?? SCHEMA_VERSION;
  if (typeof v !== "number" || v > SCHEMA_VERSION) {
    throw new DwError("UNSUPPORTED_SCHEMA_VERSION", `Scene schemaVersion ${String(v)} is newer than this engine supports (${SCHEMA_VERSION}).`, {
      hint: "Upgrade devicewrapper.",
    });
  }
  // Version 1 is the first version; future migrations chain here: if (v === 1) { ...; v = 2 }.
  obj.schemaVersion = SCHEMA_VERSION;
  return obj;
}

export interface SceneSummary {
  id: string;
  name?: string;
  nodes: number;
  devices: number;
  duration: number;
  size: string;
  updatedAt: string;
}

/** Scenes persisted as canonical JSON files: <dataDir>/scenes/<id>.json. */
export class SceneStore {
  constructor(private readonly ws: Workspace) {}

  private file(id: string): string {
    const ok = Id.safeParse(id);
    if (!ok.success) throw new DwError("INVALID_ID", `'${id}' is not a valid scene ID (letters, digits, '-', '_').`);
    return join(this.ws.scenesDir, `${id}.json`);
  }

  exists(id: string): boolean {
    return existsSync(this.file(id));
  }

  ids(): string[] {
    if (!existsSync(this.ws.scenesDir)) return [];
    return readdirSync(this.ws.scenesDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5))
      .filter((id) => Id.safeParse(id).success)
      .sort();
  }

  list(): SceneSummary[] {
    const out: SceneSummary[] = [];
    for (const id of this.ids()) {
      try {
        const s = this.load(id);
        const summary: SceneSummary = {
          id,
          nodes: s.nodes.length,
          devices: s.nodes.filter((n) => n.kind === "device").length,
          duration: s.canvas.duration,
          size: `${s.canvas.width}x${s.canvas.height}`,
          updatedAt: statSync(this.file(id)).mtime.toISOString(),
        };
        if (s.name) summary.name = s.name;
        out.push(summary);
      } catch {
        // Unreadable scenes are reported by load(); list stays usable.
      }
    }
    return out;
  }

  load(id: string): Scene {
    const f = this.file(id);
    if (!existsSync(f)) {
      const ids = this.ids();
      throw new DwError("SCENE_NOT_FOUND", `Scene '${id}' does not exist. Existing scenes: ${ids.length ? ids.join(", ") : "(none)"}.`, {
        hint: "Create one with create_scene or compose_scene.",
      });
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(f, "utf8"));
    } catch (e) {
      throw new DwError("SCENE_CORRUPT", `Scene file ${f} is not valid JSON: ${(e as Error).message}`);
    }
    const scene = parseScene(migrateScene(raw));
    if (scene.id !== id) scene.id = id;
    return scene;
  }

  /** Writes atomically (temp file + rename). Returns the path and canonical hash. */
  save(scene: Scene): { path: string; hash: string } {
    this.ws.ensureDirs();
    const f = this.file(scene.id);
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, canonicalStringify(scene));
    renameSync(tmp, f);
    return { path: f, hash: hashValue(scene) };
  }

  delete(id: string): void {
    const f = this.file(id);
    if (!existsSync(f)) throw new DwError("SCENE_NOT_FOUND", `Scene '${id}' does not exist.`);
    rmSync(f);
  }

  allocateId(base: string): string {
    return allocateId(base, new Set(this.ids()));
  }
}
