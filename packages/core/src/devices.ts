import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DeviceDefinition } from "@devicewrapper/schema";
import { DwError, schemaError } from "./errors.js";

/** Built-in assets ship inside the core package: packages/core/assets. */
export const BUILTIN_ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");

export class DeviceRegistry {
  private readonly defs = new Map<string, DeviceDefinition>();

  constructor(defs: Iterable<DeviceDefinition> = []) {
    for (const d of defs) this.defs.set(d.id, d);
  }

  /** Loads built-in definitions, then any extra directories (later ones override by ID). */
  static load(extraDirs: string[] = []): DeviceRegistry {
    const reg = new DeviceRegistry();
    for (const dir of [join(BUILTIN_ASSETS_DIR, "devices"), ...extraDirs]) reg.loadDir(dir);
    return reg;
  }

  loadDir(dir: string): void {
    if (!existsSync(dir)) return;
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith(".json")) continue;
      const full = join(dir, file);
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(full, "utf8"));
      } catch (e) {
        throw new DwError("DEVICE_DEFINITION_INVALID", `Device definition ${full} is not valid JSON: ${(e as Error).message}`);
      }
      const parsed = DeviceDefinition.safeParse(raw);
      if (!parsed.success) throw schemaError(parsed.error.issues, "", `Device definition ${full}`);
      this.defs.set(parsed.data.id, parsed.data);
    }
  }

  get(id: string): DeviceDefinition | undefined {
    return this.defs.get(id);
  }

  require(id: string): DeviceDefinition {
    const d = this.defs.get(id);
    if (!d) {
      throw new DwError("UNKNOWN_DEVICE_MODEL", `Unknown device model '${id}'. Available: ${this.ids().join(", ")}.`, {
        hint: "Read the devicewrapper://devices resource for models and colors.",
      });
    }
    return d;
  }

  ids(): string[] {
    return [...this.defs.keys()].sort();
  }

  list(): DeviceDefinition[] {
    return this.ids().map((id) => this.defs.get(id)!);
  }
}

export interface ResolvedDeviceColor {
  body: string;
  finish: "metal" | "matte" | "glossy";
  variant: string | null;
}

/** Resolves a node's `color` (variant name, hex, or undefined) against a definition. */
export function resolveDeviceColor(def: DeviceDefinition, color: string | undefined): ResolvedDeviceColor | null {
  if (color === undefined) {
    const v = def.colors[0]!;
    return { body: v.body, finish: v.finish, variant: v.name };
  }
  const v = def.colors.find((c) => c.name === color);
  if (v) return { body: v.body, finish: v.finish, variant: v.name };
  if (/^#([0-9a-fA-F]{6})$/.test(color)) return { body: color, finish: def.colors[0]!.finish, variant: null };
  return null;
}
