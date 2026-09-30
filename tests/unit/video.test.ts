import { describe, expect, it } from "vitest";
import { clipFrameIndex, encoderArgs, fitFilter } from "@devicewrapper/renderer";

describe("video frame mapping", () => {
  it("maps timeline time to decoded frames with offset and looping", () => {
    expect(clipFrameIndex(0, 30, 90, 0, true)).toBe(0);
    expect(clipFrameIndex(1, 30, 90, 0, true)).toBe(30);
    expect(clipFrameIndex(3, 30, 90, 0, true)).toBe(0);
    expect(clipFrameIndex(3.5, 30, 90, 0, true)).toBe(15);
    expect(clipFrameIndex(0, 30, 90, 0.5, true)).toBe(15);
  });

  it("holds the last frame when not looping", () => {
    expect(clipFrameIndex(10, 30, 90, 0, false)).toBe(89);
  });

  it("is stable at exact frame boundaries", () => {
    for (let i = 0; i < 300; i++) expect(clipFrameIndex(i / 30, 30, 1000, 0, false)).toBe(i);
  });
});

describe("ffmpeg filter and encoder arguments", () => {
  const base = { absPath: "a.mp4", srcWidth: 1000, srcHeight: 2000, width: 500, height: 800, fps: 30, fit: "cover" as const, focus: [0.5, 0] as [number, number], background: "#112233" };

  it("cover scales to fill and crops at the focus point", () => {
    expect(fitFilter(base)).toBe("fps=30,scale=500:1000:flags=lanczos,crop=500:800:0:0,format=rgb24");
  });

  it("contain letterboxes with the background color", () => {
    expect(fitFilter({ ...base, fit: "contain" })).toBe("fps=30,scale=400:800:flags=lanczos,pad=500:800:50:0:color=0x112233,format=rgb24");
  });

  it("applies crop and rotation before fitting", () => {
    const f = fitFilter({ ...base, crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.5 }, rotation: 90 });
    expect(f.startsWith("fps=30,crop=500:1000:100:400,transpose=1,")).toBe(true);
  });

  it("uses only argument arrays with fixed codec names", () => {
    const mp4 = encoderArgs("mp4", { width: 640, height: 360, fps: 30, quality: 90, transparent: false, output: "/o.mp4" });
    expect(mp4).toContain("libx264");
    expect(mp4.join(" ")).toContain("format=yuv420p");
    expect(mp4[mp4.length - 1]).toBe("/o.mp4");
    const webm = encoderArgs("webm", { width: 640, height: 360, fps: 30, quality: 90, transparent: true, output: "/o.webm" });
    expect(webm.join(" ")).toContain("format=yuva420p");
    const mov = encoderArgs("mov", { width: 640, height: 360, fps: 30, quality: 90, transparent: true, output: "/o.mov" });
    expect(mov).toContain("yuva444p10le");
    expect(mov).toContain("prores_ks");
  });

  it("maps quality to CRF monotonically", () => {
    const crf = (q: number) => Number(encoderArgs("mp4", { width: 2, height: 2, fps: 1, quality: q, transparent: false, output: "x" }).at(encoderArgs("mp4", { width: 2, height: 2, fps: 1, quality: q, transparent: false, output: "x" }).indexOf("-crf") + 1));
    expect(crf(100)).toBeLessThan(crf(50));
    expect(crf(50)).toBeLessThan(crf(1));
  });
});
