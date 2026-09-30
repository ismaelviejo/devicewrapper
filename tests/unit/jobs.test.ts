import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addNode, createScene, NO_RENDERER_CAPABILITIES, type RenderBackend, type RendererCapabilities } from "@devicewrapper/core";
import { devices, makeEngine, tmpWorkspace } from "../helpers.js";

const caps: RendererCapabilities = { ...NO_RENDERER_CAPABILITIES, backgrounds: ["solid"], stillFormats: ["png"], videoFormats: [] };

function fakeBackend(opts: { delayMs?: number; fail?: boolean } = {}): RenderBackend & { calls: number } {
  const b = {
    name: "fake",
    capabilities: caps,
    calls: 0,
    async renderStill(_scene: unknown, _frame: unknown, _o: unknown, signal?: AbortSignal) {
      b.calls++;
      await new Promise<void>((res, rej) => {
        const t = setTimeout(res, opts.delayMs ?? 5);
        signal?.addEventListener("abort", () => {
          clearTimeout(t);
          rej(new Error("aborted"));
        });
      });
      if (opts.fail) throw new Error("GPU on fire");
      return Buffer.from("PNGDATA");
    },
    async close() {},
  };
  return b;
}

let root: string;
let cleanup: () => void;
beforeEach(() => ({ root, cleanup } = tmpWorkspace()));
afterEach(() => cleanup());

function seed(engine: ReturnType<typeof makeEngine>) {
  engine.store.save(addNode(createScene({ id: "hero" }), { kind: "device", model: "phone-modern" }, devices).scene);
}

describe("render jobs", () => {
  it("runs queued → completed and writes the output", async () => {
    const engine = makeEngine(root, fakeBackend());
    seed(engine);
    const job = engine.jobs.create({ sceneId: "hero" });
    expect(job.status).toBe("queued");
    const done = await engine.jobs.wait(job.jobId, 5000);
    expect(done.status).toBe("completed");
    expect(done.progress).toBe(100);
    expect(done.output).toBe(".devicewrapper/output/hero/hero.png");
    expect(readFileSync(join(root, done.output), "utf8")).toBe("PNGDATA");
  });

  it("records failures with a message", async () => {
    const engine = makeEngine(root, fakeBackend({ fail: true }));
    seed(engine);
    const done = await engine.jobs.wait(engine.jobs.create({ sceneId: "hero" }).jobId, 5000);
    expect(done.status).toBe("failed");
    expect(done.error?.message).toContain("GPU on fire");
  });

  it("cancels running and queued jobs", async () => {
    const engine = makeEngine(root, fakeBackend({ delayMs: 2000 }), { DEVICEWRAPPER_MAX_CONCURRENT_RENDERS: "1" });
    seed(engine);
    const a = engine.jobs.create({ sceneId: "hero" });
    const b = engine.jobs.create({ sceneId: "hero", output: "second.png" });
    await new Promise((r) => setTimeout(r, 50));
    expect(engine.jobs.get(a.jobId).status).toBe("running");
    expect(engine.jobs.cancel(b.jobId).status).toBe("cancelled");
    engine.jobs.cancel(a.jobId);
    expect((await engine.jobs.wait(a.jobId, 5000)).status).toBe("cancelled");
    await engine.jobs.idle();
    expect(existsSync(join(root, "second.png"))).toBe(false);
  });

  it("marks interrupted jobs as failed after a restart", async () => {
    const e1 = makeEngine(root, fakeBackend({ delayMs: 10000 }));
    seed(e1);
    const job = e1.jobs.create({ sceneId: "hero" });
    const e2 = makeEngine(root, fakeBackend());
    const reloaded = e2.jobs.get(job.jobId);
    expect(reloaded.status).toBe("failed");
    expect(reloaded.error?.code).toBe("INTERRUPTED");
    e1.jobs.cancel(job.jobId);
  });

  it("refuses invalid scenes and unsupported formats before queueing", () => {
    const engine = makeEngine(root, fakeBackend());
    const s = createScene({ id: "bad" });
    s.nodes.push({ id: "x", kind: "group", parent: "ghost" } as never);
    engine.store.save(s);
    expect(() => engine.jobs.create({ sceneId: "bad" })).toThrow(/error/);
    seed(engine);
    expect(() => engine.jobs.create({ sceneId: "hero", format: "mp4" })).toThrow(/Video rendering/);
    expect(() => engine.jobs.create({ sceneId: "hero", output: "../../x.png" })).toThrow(/outside/);
  });

  it("keeps aspect ratio when only width is given", () => {
    const engine = makeEngine(root, fakeBackend());
    seed(engine);
    const j = engine.jobs.create({ sceneId: "hero", width: 960 });
    expect([j.width, j.height]).toEqual([960, 540]);
  });
});
