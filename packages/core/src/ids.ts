/**
 * Deterministic ID allocation. Never random: 'phone', 'phone-2', 'phone-3', ...
 */
export function slugify(input: string): string {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s || "item";
}

export function allocateId(base: string, taken: ReadonlySet<string>): string {
  const b = slugify(base);
  if (!taken.has(b)) return b;
  for (let i = 2; i < 100000; i++) {
    const candidate = `${b}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`Could not allocate an ID for '${base}'`);
}
