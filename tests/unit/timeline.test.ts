import { describe, expect, it } from "vitest";
import {
  easingFn,
  eulerDegToQuat,
  evaluateFrame,
  evaluateTrack,
  lerpColor,
  parseScene,
  quatRotate,
  slerp,
  frameCount,
} from "@devicewrapper/core";
import type { Track } from "@devicewrapper/schema";
import { EASINGS } from "@devicewrapper/schema";

const track = (keyframes: Track["keyframes"], interpolation: Track["interpolation"] = "auto"): Track => ({
  target: "x",
  property: "p",
  interpolation,
  keyframes,
});

const close = (a: number[], b: number[], eps = 1e-6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, -Math.log10(eps)));

describe("easing", () => {
  it("every named easing maps 0→0 and 1→1", () => {
    for (const e of EASINGS) {
      if (e === "step") continue;
      expect(easingFn(e)(0)).toBeCloseTo(0, 6);
      expect(easingFn(e)(1)).toBeCloseTo(1, 6);
    }
  });

  it("easeInOut is symmetric and slow at the ends", () => {
    const f = easingFn("easeInOut");
    expect(f(0.5)).toBeCloseTo(0.5, 5);
    expect(f(0.1)).toBeLessThan(0.1);
    expect(f(0.9)).toBeGreaterThan(0.9);
  });

  it("cubic-bezier linear control points behave linearly", () => {
    const f = easingFn({ cubicBezier: [0.25, 0.25, 0.75, 0.75] });
    for (const x of [0.1, 0.3, 0.77]) expect(f(x)).toBeCloseTo(x, 4);
  });

  it("step holds until the end of the segment", () => {
    expect(easingFn("step")(0.99)).toBe(0);
    expect(easingFn("step")(1)).toBe(1);
  });
});

describe("track evaluation", () => {
  const kf = [
    { t: 1, value: 10, easing: "linear" as const },
    { t: 3, value: 30, easing: "linear" as const },
  ];

  it("holds first and last values outside the keyframe range", () => {
    expect(evaluateTrack(track(kf), "number", 0)).toBe(10);
    expect(evaluateTrack(track(kf), "number", 99)).toBe(30);
  });

  it("interpolates numbers linearly", () => {
    expect(evaluateTrack(track(kf), "number", 2)).toBeCloseTo(20);
  });

  it("uses the easing of the segment's starting keyframe", () => {
    const eased = evaluateTrack(track([{ t: 0, value: 0, easing: "easeIn" }, { t: 1, value: 1, easing: "linear" }]), "number", 0.5) as number;
    expect(eased).toBeLessThan(0.5);
  });

  it("booleans step", () => {
    const t = track([{ t: 0, value: true, easing: "linear" }, { t: 1, value: false, easing: "linear" }]);
    expect(evaluateTrack(t, "boolean", 0.9)).toBe(true);
    expect(evaluateTrack(t, "boolean", 1)).toBe(false);
  });

  it("rotation lerps Euler degrees so a 360° spin actually spins", () => {
    const t = track([{ t: 0, value: [0, 0, 0], easing: "linear" }, { t: 1, value: [0, 360, 0], easing: "linear" }]);
    const q = evaluateTrack(t, "rotation", 0.5) as number[];
    // Halfway through a full spin is a 180° turn: the local +Z axis points to -Z.
    close(quatRotate(q as [number, number, number, number], [0, 0, 1]), [0, 0, -1]);
  });

  it("slerp takes the shortest path", () => {
    const t = track([{ t: 0, value: [0, 0, 0], easing: "linear" }, { t: 1, value: [0, 350, 0], easing: "linear" }], "slerp");
    const q = evaluateTrack(t, "rotation", 0.5) as [number, number, number, number];
    // Shortest path from 0 to 350 (= -10) passes -5°, not 175°.
    const expected = eulerDegToQuat([0, -5, 0]);
    const dot = Math.abs(q.reduce((s, v, i) => s + v * expected[i]!, 0));
    expect(dot).toBeCloseTo(1, 6);
  });

  it("spline passes through every keyframe", () => {
    const pts = [
      { t: 0, value: [0, 0, 1] as [number, number, number], easing: "linear" as const },
      { t: 1, value: [1, 0, 0] as [number, number, number], easing: "linear" as const },
      { t: 2, value: [0, 0, -1] as [number, number, number], easing: "linear" as const },
    ];
    const t = track(pts, "spline");
    for (const p of pts) close(evaluateTrack(t, "vec3", p.t) as number[], p.value);
    const mid = evaluateTrack(t, "vec3", 0.5) as number[];
    const lin = [0.5, 0, 0.5];
    expect(Math.hypot(...mid)).toBeGreaterThan(Math.hypot(...lin)); // curves outward like an orbit
  });

  it("colors blend in linear light", () => {
    expect(lerpColor("#000000", "#ffffff", 0)).toBe("#000000");
    expect(lerpColor("#000000", "#ffffff", 1)).toBe("#ffffff");
    expect(lerpColor("#000000", "#ffffff", 0.5)).toBe("#bcbcbc");
  });

  it("slerp endpoints", () => {
    const a = eulerDegToQuat([0, 0, 0]);
    const b = eulerDegToQuat([0, 90, 0]);
    close(slerp(a, b, 0), a);
    close(slerp(a, b, 1), b);
  });
});

describe("evaluateFrame", () => {
  const scene = parseScene({
    id: "anim",
    canvas: { duration: 4, fps: 30 },
    nodes: [{ id: "phone", kind: "device", model: "phone-modern" }],
    lights: [{ id: "key", type: "directional" }],
    animation: {
      tracks: [
        { target: "phone", property: "position", keyframes: [{ t: 0, value: [0, 0, 0] }, { t: 4, value: [0, 0.1, 0] }] },
        { target: "camera", property: "fov", keyframes: [{ t: 0, value: 40 }, { t: 4, value: 20 }] },
        { target: "key", property: "intensity", keyframes: [{ t: 0, value: 0 }, { t: 2, value: 4 }] },
        { target: "phone", property: "screen.brightness", keyframes: [{ t: 0, value: 0 }, { t: 1, value: 1 }] },
      ],
    },
  });

  it("samples nodes, camera and lights", () => {
    const f = evaluateFrame(scene, 2);
    close(f.nodes.phone!.position, [0, 0.05, 0]);
    expect(f.camera.fov).toBeCloseTo(30);
    expect(f.lights.key!.intensity).toBeCloseTo(4);
    expect(f.nodes.phone!.screenBrightness).toBe(1);
  });

  it("is deterministic and serializes identically", () => {
    const a = JSON.stringify(evaluateFrame(scene, 1.2345));
    const b = JSON.stringify(evaluateFrame(scene, 1.2345));
    expect(a).toBe(b);
  });

  it("frame count", () => {
    expect(frameCount(4, 30)).toBe(120);
    expect(frameCount(0, 30)).toBe(1);
  });
});
