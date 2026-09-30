import type { Engine } from "@devicewrapper/jobs";
import type { Scene } from "@devicewrapper/schema";

/** Loads a scene, applies a change, saves it, and reports any validation issues the change introduced. */
export async function mutate<T extends Record<string, unknown>>(
  engine: Engine,
  sceneId: string,
  fn: (scene: Scene) => Promise<{ scene: Scene; result?: T }> | { scene: Scene; result?: T },
): Promise<Record<string, unknown>> {
  const before = engine.store.load(sceneId);
  const { scene, result } = await fn(before);
  engine.store.save(scene);
  return { sceneId: scene.id, ...(result ?? {}), ...issuesOf(engine, scene) };
}

/** Short issue list attached to mutation results so agents see problems immediately. */
export function issuesOf(engine: Engine, scene: Scene): Record<string, unknown> {
  const report = engine.validate(scene);
  const issues = [...report.errors, ...report.warnings];
  if (issues.length === 0) return {};
  return {
    issues: issues.slice(0, 6).map((i) => `${i.severity}: ${i.message}`),
    ...(issues.length > 6 ? { moreIssues: issues.length - 6 } : {}),
  };
}

export function round3(v: readonly number[]): number[] {
  return v.map((x) => Math.round(x * 1000) / 1000);
}
