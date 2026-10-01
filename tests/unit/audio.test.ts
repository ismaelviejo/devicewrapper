import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DwError,
  MOTION_SOUNDS,
  SOUND_CUE_NAMES,
  SOUND_PACK_NAMES,
  addNode,
  applyLayout,
  applyMotion,
  applyMotionClip,
  buildAudioPlan,
  sceneToMotionClip,
  composeScene,
  createScene,
  loadConfig,
  removeNode,
  resolveSound,
  setAudio,
  sniffFile,
  validateScene,
  Workspace,
  type Scene,
} from "@devicewrapper/core";
import { audioMuxArgs } from "@devicewrapper/renderer";
import { devices, tmpWorkspace, writeScreenshot } from "../helpers.js";

const trio = (): Scene => {
  let s = createScene({ id: "a" });
  for (let i = 0; i < 3; i++) s = addNode(s, { kind: "device", model: "phone-modern" }, devices).scene;
  return applyLayout(s, { layout: "arc" }, devices);
};

describe("sound library", () => {
  it("ships the 12 UI SFX packs with 78 cues, minimal by default", () => {
    expect(SOUND_PACK_NAMES).toHaveLength(12);
    expect(SOUND_PACK_NAMES).toContain("minimal");
    expect(SOUND_CUE_NAMES).toHaveLength(78);
    const s = resolveSound("swipe");
    expect(s.pack).toBe("minimal");
    expect(s.file.endsWith("sounds/minimal/swipe.mp3")).toBe(true);
    expect(resolveSound("cinematic/drop").pack).toBe("cinematic");
    expect(resolveSound("open", "glass").pack).toBe("glass");
  });

  it("names unknown packs and cues", () => {
    expect(() => resolveSound("whoosh")).toThrow(DwError);
    expect(() => resolveSound("nope/swipe")).toThrow(/Packs:/);
  });

  it("every motion sound points at a real cue", () => {
    for (const list of Object.values(MOTION_SOUNDS)) for (const s of list) expect(SOUND_CUE_NAMES).toContain(s.cue);
  });
});

describe("motion presets add sound cues", () => {
  it("one cue per device, following the stagger", () => {
    const r = applyMotion(trio(), { preset: "rise" }, devices);
    expect(r.sounds).toBe(3);
    expect(r.scene.audio.cues.map((c) => [c.t, c.sound, c.source])).toEqual([
      [0, "open", "motion:rise:phone"],
      [0.12, "open", "motion:rise:phone-2"],
      [0.24, "open", "motion:rise:phone-3"],
    ]);
  });

  it("re-applying replaces its own cues; sound: false and camera moves add none", () => {
    let s = applyMotion(trio(), { preset: "drop-in", duration: 1 }, devices).scene;
    s = applyMotion(s, { preset: "drop-in", duration: 2, stack: "replace" }, devices).scene;
    expect(s.audio.cues).toHaveLength(3);
    expect(s.audio.cues[0]!.t).toBeCloseTo(0.74, 3);
    expect(applyMotion(trio(), { preset: "rise", sound: false }, devices).scene.audio.cues).toEqual([]);
    expect(applyMotion(trio(), { preset: "orbit" }, devices).scene.audio.cues).toEqual([]);
  });

  it("target 'all' plays one sound for the whole arrangement", () => {
    const r = applyMotion(trio(), { preset: "turntable", target: "all", start: 1 }, devices);
    expect(r.scene.audio.cues).toEqual([{ t: 1, sound: "swipe", gain: 1.4, source: "motion:turntable:arrangement" }]);
  });

  it("removing a device removes the cues its motions added", () => {
    const s = applyMotion(trio(), { preset: "rise" }, devices).scene;
    expect(removeNode(s, "phone-2").scene.audio.cues.map((c) => c.source)).toEqual(["motion:rise:phone", "motion:rise:phone-3"]);
  });
});

describe("motion clips carry their sounds", () => {
  it("saves the cues in the window with their pack and replays them at the new start", () => {
    let s = createScene({ id: "src", canvas: { duration: 3 } });
    s = addNode(s, { kind: "device", model: "phone-modern" }, devices).scene;
    s = applyMotion(s, { preset: "spin-reveal", start: 1, duration: 1 }, devices).scene;
    s = setAudio(s, { pack: "glass", add: [{ t: 0.2, sound: "select" }] });
    const { clip } = sceneToMotionClip(s, devices, { range: [0.9, 2] });
    expect(clip.sounds).toEqual([{ t: 0.1, sound: "glass/swipe", gain: 1.4 }]);
    let target = createScene({ id: "dst", canvas: { duration: 2 } });
    target = addNode(target, { kind: "device", model: "tablet" }, devices).scene;
    const r = applyMotionClip(target, clip, devices, { start: 0.5 });
    expect(r.sounds).toBe(1);
    expect(r.scene.audio.cues).toEqual([{ t: 0.6, sound: "glass/swipe", gain: 1.4, source: "clip:tablet:0.5" }]);
    // Replaying at the same start replaces, not duplicates.
    expect(applyMotionClip(r.scene, clip, devices, { start: 0.5 }).scene.audio.cues).toHaveLength(1);
  });
});

describe("set_audio and validation", () => {
  it("adds, removes and validates cues", () => {
    let s = applyMotion(trio(), { preset: "rise" }, devices).scene;
    s = setAudio(s, { pack: "cinematic", add: [{ t: 2, sound: "success" }, { t: 0.5, sound: "glass/snap", gain: 0.5 }] });
    expect(s.audio.pack).toBe("cinematic");
    expect(s.audio.cues.map((c) => c.t)).toEqual([0, 0.12, 0.24, 0.5, 2]);
    expect(setAudio(s, { remove: "motion" }).audio.cues.map((c) => c.sound)).toEqual(["glass/snap", "success"]);
    expect(setAudio(s, { remove: "manual" }).audio.cues).toHaveLength(3);
    expect(setAudio(s, { remove: [0, 4] }).audio.cues).toHaveLength(3);
    expect(() => setAudio(s, { add: [{ t: 1, sound: "kaboom" }] })).toThrow(/No sound 'kaboom'/);
    expect(() => setAudio(s, { add: [{ t: 1 }] })).toThrow(DwError);
    expect(() => setAudio(s, { pack: "loud" })).toThrow(/Packs:/);
    expect(validateScene(s, { devices }).valid).toBe(true);
  });

  it("warns about cues after the end and errors on unknown sounds in a hand-written scene", () => {
    const s = createScene({ id: "v", canvas: { duration: 2 } });
    const bad = { ...s, audio: { ...s.audio, cues: [{ t: 5, sound: "swipe", gain: 1 }, { t: 0, sound: "boing", gain: 1 }] } };
    const r = validateScene(bad, { devices });
    expect(r.errors.map((e) => e.code)).toEqual(["UNKNOWN_SOUND"]);
    expect(r.warnings.map((w) => w.code)).toContain("CUE_AFTER_END");
  });

  it("compose_scene adds motion sounds by default, a pack by name, none with sound: false", async () => {
    const { root, cleanup } = tmpWorkspace();
    try {
      await writeScreenshot(join(root, "a.png"), 118, 256);
      const ws = new Workspace(loadConfig({ DEVICEWRAPPER_WORKSPACE: root }, root));
      const brief = { devices: [{ screen: "a.png" }], motion: ["rise"] };
      expect((await composeScene(ws, devices, brief, "x")).audio.cues).toHaveLength(1);
      const cine = await composeScene(ws, devices, { ...brief, sound: "cinematic" }, "y");
      expect(cine.audio.pack).toBe("cinematic");
      expect((await composeScene(ws, devices, { ...brief, sound: false }, "z")).audio.cues).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe("audio plan and mixing", () => {
  it("offsets cues into the rendered range and weights them by the pack's levels", () => {
    let s = applyMotion(trio(), { preset: "rise" }, devices).scene;
    s = setAudio(s, { add: [{ t: 4.9, sound: "success", gain: 2 }] });
    const plan = buildAudioPlan(s, { start: 0.1, end: 5 }, (p) => p)!;
    expect(plan.duration).toBe(4.9);
    expect(plan.clips.map((c) => [c.at, c.skip])).toEqual([
      [0, 0.1],
      [0.02, 0],
      [0.14, 0],
      [4.8, 0],
    ]);
    expect(plan.clips[3]!.gain).toBeGreaterThan(plan.clips[0]!.gain);
    expect(buildAudioPlan(setAudio(s, { enabled: false }), { start: 0, end: 5 }, (p) => p)).toBeNull();
    expect(buildAudioPlan(trio(), { start: 0, end: 5 }, (p) => p)).toBeNull();
  });

  it("builds an argument array that delays, mixes, limits and copies the video", () => {
    const plan = { duration: 3, clips: [{ file: "/s/a.mp3", at: 0, skip: 0, gain: 1 }, { file: "/s/b.mp3", at: 1.25, skip: 0, gain: 0.5 }, { file: "/m/song.mp3", at: 0, skip: 2, gain: 0.6, loop: true, fadeIn: 0.5, fadeOut: 1 }] };
    const args = audioMuxArgs("mp4", plan, "v.mp4", "out.mp4");
    const fc = args[args.indexOf("-filter_complex") + 1]!;
    expect(fc).toContain("[2:a]atrim=start=0,asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=0.5,adelay=1250:all=1[a1]");
    expect(fc).toContain("afade=t=out:st=2:d=1");
    expect(fc).toContain("amix=inputs=3:normalize=0");
    expect(fc).toContain("apad=whole_dur=3,atrim=end=3,alimiter");
    expect(args.slice(0, 2)).toEqual(["-i", "v.mp4"]);
    expect(args).toContain("-stream_loop");
    expect(args.join(" ")).toContain("-c:v copy -c:a aac");
    expect(audioMuxArgs("webm", plan, "v", "o").join(" ")).toContain("-c:a libopus");
    expect(audioMuxArgs("mov", plan, "v", "o").join(" ")).toContain("-c:a pcm_s16le");
  });

  it("recognises audio files by their bytes", () => {
    const { root, cleanup } = tmpWorkspace();
    try {
      const wav = Buffer.alloc(44);
      wav.write("RIFF", 0);
      wav.write("WAVE", 8);
      writeFileSync(join(root, "a.bin"), wav);
      expect(sniffFile(join(root, "a.bin"))).toEqual({ type: "audio", format: "wav" });
      writeFileSync(join(root, "b.bin"), Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00", "latin1"));
      expect(sniffFile(join(root, "b.bin"))).toEqual({ type: "audio", format: "mp3" });
      expect(sniffFile(resolveSound("swipe").file)?.type).toBe("audio");
    } finally {
      cleanup();
    }
  });
});
