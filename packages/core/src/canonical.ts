import { createHash } from "node:crypto";

/**
 * Canonical JSON: object keys sorted, -0 normalized, 2-space indent, trailing newline.
 * Identical scenes always serialize to identical bytes, so the hash is a stable cache key.
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue;
      out[key] = canonicalize(v);
    }
    return out;
  }
  if (typeof value === "number") {
    if (Object.is(value, -0)) return 0;
    if (!Number.isFinite(value)) throw new Error(`Non-finite number in scene: ${value}`);
  }
  return value;
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value), null, 2) + "\n";
}

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function hashValue(value: unknown): string {
  return "sha256:" + sha256(canonicalStringify(value));
}
