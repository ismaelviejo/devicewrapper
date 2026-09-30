/**
 * Messages between the Node renderer and the in-browser page bundle.
 * Plain JSON only; binary data (textures, fonts) is fetched by URL from the page.
 */
import type { FrameState } from "@devicewrapper/core";
import type { DeviceDefinition, Effect, Environment, Light, Material } from "@devicewrapper/schema";

export type PageBackground =
  | { type: "solid"; color: string }
  | { type: "gradient"; kind: "linear" | "radial"; angle: number; center: [number, number]; radius: number; stops: Array<{ color: string; offset: number }> }
  | { type: "image"; url: string }
  | { type: "transparent" };

interface PageNodeBase {
  id: string;
  parent?: string;
  castShadow: boolean;
  receiveShadow: boolean;
}

export interface PageDevice extends PageNodeBase {
  kind: "device";
  def: DeviceDefinition;
  bodyColor: string;
  finish: "metal" | "matte" | "glossy";
  bodyMaterial?: Material;
  /** Screen texture URL, or a solid color when the screen shows a color. */
  screenUrl?: string;
  screenColor: string;
}

export interface PagePlane extends PageNodeBase {
  kind: "plane";
  size: [number, number];
  material: Material;
}

export interface PagePrimitive extends PageNodeBase {
  kind: "primitive";
  shape: "box" | "sphere" | "cylinder" | "cone" | "torus" | "capsule";
  size: [number, number, number];
  cornerRadius: number;
  material: Material;
}

export interface PageGroup extends PageNodeBase {
  kind: "group";
}

export interface PageText {
  id: string;
  kind: "text2d";
  content: string;
  font: string;
  weight: number;
  align: "left" | "center" | "right";
  letterSpacing: number;
  lineHeight: number;
  maxWidth: number;
}

export type PageNode = PageDevice | PagePlane | PagePrimitive | PageGroup | PageText;

export interface PageFont {
  family: string;
  url: string;
  weight?: string;
  unicodeRange?: string;
}

export interface LoadPayload {
  key: string;
  cameraType: "perspective" | "orthographic";
  near: number;
  far: number;
  environment: Environment;
  effects: Effect[];
  lights: Light[];
  nodes: PageNode[];
  fonts: PageFont[];
  seed: number;
}

export interface RenderFrameOptions {
  /** Size of the drawing buffer (already multiplied by supersampling). */
  width: number;
  height: number;
  /** Supersampling factor, used to scale 2D overlays (text sizes are in output pixels). */
  scale: number;
  transparent: boolean;
  /** Frame index, for per-frame deterministic noise. */
  frameIndex: number;
  /** Background, sized for this render (image URLs are prepared at the buffer size). */
  background: PageBackground;
  /** Per-frame screen images for video screens: node ID -> frame URL. */
  screenFrames?: Record<string, string>;
  /** 'png' returns base64 PNG at buffer size; 'rgba' downsamples to outWidth x outHeight and POSTs raw RGBA to uploadUrl. */
  output: "png" | "rgba";
  outWidth?: number;
  outHeight?: number;
  uploadUrl?: string;
}

export interface PageLimits {
  maxRenderbufferSize: number;
  maxViewport: [number, number];
  maxTextureSize: number;
  renderer: string;
}

export interface PageApi {
  limits(): PageLimits;
  load(payload: LoadPayload): Promise<void>;
  render(frame: FrameState, opts: RenderFrameOptions): Promise<string>;
}
