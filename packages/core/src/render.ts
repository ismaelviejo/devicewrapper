import type { FrameState } from "./timeline.js";
import type { ResolvedScene } from "./resolve.js";
import type { RendererCapabilities } from "./validate.js";

/**
 * The contract every renderer backend implements. Core and the job queue only know this interface,
 * so backends (Three.js in Chromium today, Blender later) are swappable.
 */

export type StillFormat = "png" | "jpeg" | "webp";
export type VideoFormat = "mp4" | "webm" | "mov";

export interface FrameOptions {
  /** Final output size in pixels. */
  width: number;
  height: number;
  /** Render at N× and downscale. */
  supersample: number;
  transparent: boolean;
}

export interface StillOptions extends FrameOptions {
  format: StillFormat;
  quality: number;
}

export interface VideoOptions extends FrameOptions {
  format: VideoFormat;
  quality: number;
  fps: number;
  /** Frame indices [start, end) to render. */
  startFrame: number;
  endFrame: number;
  outputPath: string;
  onProgress?: (framesDone: number, framesTotal: number) => void;
}

export interface RenderBackend {
  readonly name: string;
  readonly capabilities: RendererCapabilities;
  renderStill(scene: ResolvedScene, frame: FrameState, opts: StillOptions, signal?: AbortSignal): Promise<Buffer>;
  renderVideo?(scene: ResolvedScene, frameAt: (index: number) => FrameState, opts: VideoOptions, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

/** Capabilities reported when no renderer is attached: the scene layer still works, nothing draws. */
export const NO_RENDERER_CAPABILITIES: RendererCapabilities = {
  backgrounds: [],
  screenSources: [],
  effects: [],
  depthOfField: false,
  text: false,
  video: false,
  fonts: [],
  stillFormats: [],
  videoFormats: [],
};
