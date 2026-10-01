import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Workspace,
  addNode,
  applyMotion,
  applyMotionClip,
  composeScene,
  createScene,
  evaluateFrame,
  instantiateSceneTemplate,
  loadConfig,
  loadTemplates,
  sceneToMotionClip,
  sceneToTemplate,
  screenFrameLocal,
  screenPoint,
  setTrack,
  sliceTrack,
  toLocal,
  toWorld,
  trackValueAt,
  validateScene,
  worldPose,
  writeTemplate,
  type Scene,
  type Vec3,
} from "@devicewrapper/core";
import { devices, tmpWorkspace, writeScreenshot } from "../helpers.js";

const sub = (a: readonly number[], b: readonly number[]) => a.map((v, i) => v - b[i]!);
const len = (a: readonly number[]) => Math.hypot(...a);
const norm = (a: readonly number[]) => a.map((v) => v / len(a));
const close = (a: readonly number[], b: readonly number[], digits = 4) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, digits));

/** One phone, turned and moved off the origin, with a spin and a camera move: a small "reel" scene. */
function reelScene(id = "reel"): Scene {
  let s = createScene({ id, canvas: { duration: 4 } });
  s = addNode(s, { kind: "device", id: "phone", model: "phone-modern", transform: { position: [0.02, 0, 0], rotation: [0, -18, 0] } }, devices).scene;
  s = addNode(s, { kind: "text2d", id: "headline", content: "Tell us what you want.", anchor: [0.07, 0.36] }, devices).scene;
  s = setTrack(s, { target: "phone", property: "rotation", keyframes: [{ t: 0, value: [0, -400, 0], easing: "easeOutExpo" }, { t: 0.8, value: [0, -20, 0], easing: "easeInOutSine" }, { t: 4, value: [0, -10, 0] }] });
  s = setTrack(s, { target: "headline", property: "opacity", keyframes: [{ t: 0, value: 0 }, { t: 1.7, value: 0, easing: "easeOutCubic" }, { t: 2, value: 1 }] });
  return s;
}

describe("track windows", () => {
  it("slices a window that replays the original motion exactly", () => {
    const s = reelScene();
    const tr = s.animation.tracks.find((t) => t.property === "rotation")!;
    for (const [t0, t1] of [[0, 4], [0.3, 2], [0.8, 3.5]] as const) {
      const cut = sliceTrack(tr, "rotation", t0, t1);
      const replay = { ...tr, keyframes: cut };
      expect(cut[0]!.t).toBe(0);
      expect(cut.at(-1)!.t).toBeCloseTo(t1 - t0, 6);
      for (let u = 0; u <= t1 - t0; u += 0.05) {
        // Baked eased segments are sampled at 30 fps; between samples they stay within a fraction of a degree.
        close(trackValueAt(replay, "rotation", u) as number[], trackValueAt(tr, "rotation", t0 + u) as number[], 0);
      }
    }
  });
});

describe("focus / reframe", () => {
  it("focus puts the camera on the screen point, along the screen normal, at the requested size", () => {
    const s0 = reelScene();
    const r = applyMotion(s0, { preset: "focus", target: "phone", point: [0.5, 0.25], amount: 0.4, angle: [0, 0], start: 0.8, duration: 0.35, hold: 0.4 }, devices);
    const s = r.scene;
    const tArrive = 1.15;
    const cam = evaluateFrame(s, tArrive).camera;
    const def = devices.require("phone-modern");
    const sf = screenFrameLocal(def);
    const pose = worldPose(s, "phone", tArrive);
    const P = toWorld(pose, screenPoint(sf, [0.5, 0.25]));
    close(cam.target, P);
    const normal = toWorld({ ...pose, p: [0, 0, 0] }, sf.normal);
    close(norm(sub(cam.position, cam.target)), norm(normal), 3);
    const visible = 2 * len(sub(cam.position, cam.target)) * Math.tan((cam.fov * Math.PI) / 360);
    expect(visible).toBeCloseTo(0.4 * sf.height, 4);
    // Before the move the camera is where it was; during the hold it keeps drifting in.
    close(evaluateFrame(s, 0.2).camera.position, s0.camera.position);
    expect(len(sub(evaluateFrame(s, 1.55).camera.position, P))).toBeLessThan(len(sub(cam.position, P)));
    expect(validateScene(s, { devices }).valid).toBe(true);
  });

  it("reframe returns to the base camera, and chained moves keep each other's windows", () => {
    let s = reelScene();
    s = applyMotion(s, { preset: "focus", start: 0.75, hold: 0.4 }, devices).scene;
    const atFocus = evaluateFrame(s, 1.3).camera.position;
    s = applyMotion(s, { preset: "reframe", start: 1.5, duration: 0.45, hold: 1, drift: 0 }, devices).scene;
    close(evaluateFrame(s, 1.3).camera.position, atFocus);
    close(evaluateFrame(s, 2.5).camera.position, s.camera.position);
    s = applyMotion(s, { preset: "reframe", start: 3, shot: "front", padding: 0.3 }, devices).scene;
    expect(evaluateFrame(s, 3.45).camera.position).not.toEqual(s.camera.position);
  });
});

describe("saved templates", () => {
  let root: string;
  let cleanup: () => void;
  let ws: Workspace;
  beforeEach(async () => {
    ({ root, cleanup } = tmpWorkspace());
    ws = new Workspace(loadConfig({ DEVICEWRAPPER_WORKSPACE: root, DEVICEWRAPPER_TEMPLATES_DIR: join(root, "global") }, root));
    for (const n of [1, 2]) await writeScreenshot(join(root, `s${n}.png`), 118, 256, n === 1 ? "#4f7cff" : "#ff7a4f");
  });
  afterEach(() => cleanup());

  async function likedScene(): Promise<Scene> {
    let s = await composeScene(ws, devices, { devices: [{ screen: "s1.png" }], style: "dark-studio", text: [{ content: "We make the calls." }], duration: 4 }, "liked");
    s = applyMotion(s, { preset: "spin-reveal", duration: 0.8, amount: 380 }, devices).scene;
    s = applyMotion(s, { preset: "focus", start: 0.75, hold: 0.4 }, devices).scene;
    s = applyMotion(s, { preset: "reframe", start: 1.5, hold: 1.2 }, devices).scene;
    return s;
  }

  it("a scene template replays the same motion on another screenshot", async () => {
    const liked = await likedScene();
    const { template, warnings } = sceneToTemplate(liked, { name: "punch-rhythm" });
    expect(warnings).toEqual([]);
    expect(template.screens).toBe(1);
    expect(template.variables).toEqual(["text"]);
    expect(Object.keys((template.scene as { assets: object }).assets)).toEqual([]);
    writeTemplate(ws.userTemplatesDir, template);

    const tpl = loadTemplates([ws.userTemplatesDir]).get("punch-rhythm")!;
    expect(tpl.kind).toBe("scene");
    const s = await instantiateSceneTemplate(ws, devices, tpl, ["s2.png"], "again", { variables: { text: "Done. It's booked." } });
    expect(s.animation.tracks).toEqual(liked.animation.tracks);
    expect(s.camera).toEqual(liked.camera);
    const phone = s.nodes.find((n) => n.kind === "device")!;
    expect(phone.kind === "device" && phone.screen.source.type === "image" && s.assets[phone.screen.source.asset]!.path).toBe("s2.png");
    expect(s.variables.text).toBe("Done. It's booked.");
    expect(validateScene(s, { devices, workspace: ws }).valid).toBe(true);
    await expect(instantiateSceneTemplate(ws, devices, tpl, ["s2.png"], "x", { devices: [] })).rejects.toThrow(/can't take devices/);
  });

  it("project templates override global ones of the same name", async () => {
    const { template } = sceneToTemplate(await likedScene(), { name: "rhythm", title: "Global" });
    writeTemplate(ws.globalTemplatesDir, template);
    writeTemplate(ws.userTemplatesDir, { ...template, title: "Project" });
    expect(() => writeTemplate(ws.userTemplatesDir, template)).toThrow(/already exists/);
    const all = loadTemplates([{ dir: ws.globalTemplatesDir, scope: "global" }, { dir: ws.userTemplatesDir, scope: "project" }]);
    expect(all.get("rhythm")).toMatchObject({ title: "Project", scope: "project" });
    expect(all.get("hero-phone")).toMatchObject({ scope: "builtin", kind: "brief" });
    expect(loadTemplates([{ dir: ws.globalTemplatesDir, scope: "global" }]).get("rhythm")).toMatchObject({ title: "Global", scope: "global" });
  });

  it("a motion clip keeps the camera's view of the device on another placement", async () => {
    const liked = await likedScene();
    const { clip } = sceneToMotionClip(liked, devices, { range: [0.75, 2] });
    expect(clip.duration).toBeCloseTo(1.25, 6);
    expect(clip.tracks.map((t) => `${t.role}.${t.property}`).sort()).toEqual(["camera.fov", "camera.position", "camera.target", "device.rotation"]);

    let other = createScene({ id: "other", canvas: { duration: 2 } });
    other = addNode(other, { kind: "device", id: "hero", model: "phone-modern", transform: { position: [0.3, 0.1, -0.2], rotation: [0, 30, 0] } }, devices).scene;
    const r = applyMotionClip(other, clip, devices, { start: 2 });
    expect(r.durationExtended).toBeCloseTo(3.25, 6);
    const srcPhone = liked.nodes.find((n) => n.kind === "device")!.id;
    for (const u of [0, 0.3, 0.6, 1.0, 1.25]) {
      const a = evaluateFrame(liked, 0.75 + u).camera;
      const b = evaluateFrame(r.scene, 2 + u).camera;
      // Same view of the device: camera position/target in the device's base frame match.
      close(toLocal(worldPose(r.scene, "hero"), b.position as Vec3), toLocal(worldPose(liked, srcPhone), a.position as Vec3), 3);
      close(toLocal(worldPose(r.scene, "hero"), b.target as Vec3), toLocal(worldPose(liked, srcPhone), a.target as Vec3), 3);
    }
    expect(validateScene(r.scene, { devices }).valid).toBe(true);
  });

  it("a motion clip keeps only the text that changes in its window", () => {
    const s = reelScene();
    const kinds = (range: [number, number]) => sceneToMotionClip(s, devices, { range }).clip.tracks.map((t) => `${t.role}.${t.property}`);
    expect(kinds([0, 0.75])).not.toContain("text1.opacity"); // headline held hidden: not part of the movement
    expect(kinds([1.5, 2.5])).toContain("text1.opacity"); // headline fades in
  });
});
