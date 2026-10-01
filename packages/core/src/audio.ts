import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { z } from "zod";
import { AudioCue, Music, type Scene } from "@devicewrapper/schema";
import { BUILTIN_ASSETS_DIR } from "./devices.js";
import { DwError, schemaError } from "./errors.js";

/**
 * Sound effects for video renders. The built-in library is UI SFX (uisfx, CC0 audio): 78 semantic
 * cues in 12 packs ("sonic personalities"). Tactil's design system uses the Minimal pack, so that is
 * the default. A cue is referenced by name ('swipe', from the scene's pack) or as 'pack/cue'.
 */

const require = createRequire(import.meta.url);
const MANIFEST_PATH = require.resolve("uisfx/manifest");
const SOUNDS_ROOT = dirname(MANIFEST_PATH);

interface ManifestAsset {
  pack: string;
  cue: string;
  duration: number;
  defaultVolume: number;
  loop: boolean;
  files: { mp3?: { path: string } };
}
interface Manifest {
  packs: Array<{ name: string; label: string; description: string; bestFor?: string }>;
  cues: Array<{ name: string; label: string; category: string; description: string; defaultVolume: number; loop: boolean }>;
  categories: Array<{ id: string; label: string; description: string }>;
  assets: ManifestAsset[];
}

const MANIFEST = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
const BY_KEY = new Map(MANIFEST.assets.map((a) => [`${a.pack}/${a.cue}`, a]));

export const SOUND_PACKS = MANIFEST.packs.map((p) => ({ name: p.name, label: p.label, description: p.description, bestFor: p.bestFor ?? "" }));
export const SOUND_PACK_NAMES = SOUND_PACKS.map((p) => p.name);
export const SOUND_CUES = MANIFEST.cues.map((c) => ({ name: c.name, category: c.category, description: c.description, loop: c.loop }));
export const SOUND_CUE_NAMES = SOUND_CUES.map((c) => c.name);
export const DEFAULT_SOUND_PACK = "minimal";

export interface ResolvedSound {
  pack: string;
  cue: string;
  file: string;
  duration: number;
  /** Relative loudness the pack intends for this cue (UI SFX defaultVolume, ~0.2 typical). */
  defaultVolume: number;
}

/** 'swipe' (from `pack`) or 'cinematic/swipe' → the file and its metadata. */
export function resolveSound(ref: string, pack: string = DEFAULT_SOUND_PACK): ResolvedSound {
  const [p, c] = ref.includes("/") ? (ref.split("/") as [string, string]) : [pack, ref];
  if (!SOUND_PACK_NAMES.includes(p)) {
    throw new DwError("UNKNOWN_SOUND_PACK", `No sound pack '${p}'. Packs: ${SOUND_PACK_NAMES.join(", ")}.`);
  }
  const a = BY_KEY.get(`${p}/${c}`);
  if (!a || !a.files.mp3) {
    throw new DwError("UNKNOWN_SOUND", `No sound '${c}' in pack '${p}'.`, {
      hint: `Motion-friendly cues: swipe, drop, open, close, snap, wake, select, success. Full list: devicewrapper://sounds.`,
    });
  }
  return { pack: p, cue: c, file: join(SOUNDS_ROOT, a.files.mp3.path), duration: a.duration, defaultVolume: a.defaultVolume };
}

/* ------------------------------------------------------------ motion sounds */

const MotionSoundsSchema = z.record(z.string(), z.array(z.object({ cue: z.string(), at: z.number().min(0).max(1), gain: z.number().min(0).max(4).default(1) })));
function loadMotionSounds(): Record<string, Array<{ cue: string; at: number; gain: number }>> {
  const path = join(BUILTIN_ASSETS_DIR, "presets", "motion-sounds.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  delete raw._doc;
  const r = MotionSoundsSchema.safeParse(raw);
  if (!r.success) throw schemaError(r.error.issues, "", `Preset file ${path}`);
  for (const list of Object.values(r.data)) for (const s of list) resolveSound(s.cue);
  return r.data;
}
export const MOTION_SOUNDS = loadMotionSounds();

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * Replaces the cues a motion added before (same `source`) with the ones for this application.
 * `runs` are the per-target start times and the shared duration.
 */
export function addMotionCues(scene: Scene, preset: string, runs: Array<{ target: string; start: number }>, duration: number): { scene: Scene; added: number } {
  const spec = MOTION_SOUNDS[preset];
  const sources = new Set(runs.map((r) => `motion:${preset}:${r.target}`));
  const kept = scene.audio.cues.filter((c) => !c.source || !sources.has(c.source));
  const added: AudioCue[] = [];
  if (spec) {
    for (const r of runs) {
      for (const s of spec) added.push({ t: r3(r.start + s.at * duration), sound: s.cue, gain: s.gain, source: `motion:${preset}:${r.target}` });
    }
  }
  if (added.length === 0 && kept.length === scene.audio.cues.length) return { scene, added: 0 };
  const cues = [...kept, ...added].sort((a, b) => a.t - b.t);
  return { scene: { ...scene, audio: { ...scene.audio, cues } }, added: added.length };
}

/* ------------------------------------------------------------------- set_audio */

export interface SetAudioOptions {
  enabled?: boolean;
  pack?: string;
  volume?: number;
  /** Cues to add (sound name or audio asset ID). */
  add?: Array<Record<string, unknown>>;
  /** Remove: 'all', 'motion' (cues added by motion presets), 'manual' (the rest), or cue indices. */
  remove?: "all" | "motion" | "manual" | number[];
  /** Set the music track, or null to remove it. */
  music?: Record<string, unknown> | null;
}

export function setAudio(scene: Scene, opts: SetAudioOptions): Scene {
  const a = structuredClone(scene.audio);
  if (opts.enabled !== undefined) a.enabled = opts.enabled;
  if (opts.pack !== undefined) {
    if (!SOUND_PACK_NAMES.includes(opts.pack)) throw new DwError("UNKNOWN_SOUND_PACK", `No sound pack '${opts.pack}'. Packs: ${SOUND_PACK_NAMES.join(", ")}.`, { path: "pack" });
    a.pack = opts.pack;
  }
  if (opts.volume !== undefined) {
    if (!(opts.volume >= 0 && opts.volume <= 4)) throw new DwError("INVALID_VALUE", "volume must be between 0 and 4.", { path: "volume" });
    a.volume = opts.volume;
  }
  if (opts.remove !== undefined) {
    const r = opts.remove;
    if (Array.isArray(r)) {
      for (const i of r) if (!Number.isInteger(i) || i < 0 || i >= a.cues.length) throw new DwError("INVALID_VALUE", `No cue at index ${i} (the scene has ${a.cues.length}).`, { path: "remove" });
      const drop = new Set(r);
      a.cues = a.cues.filter((_, i) => !drop.has(i));
    } else if (r === "all") a.cues = [];
    else if (r === "motion") a.cues = a.cues.filter((c) => !c.source?.startsWith("motion:"));
    else if (r === "manual") a.cues = a.cues.filter((c) => c.source?.startsWith("motion:"));
  }
  if (opts.add) {
    opts.add.forEach((raw, i) => {
      const r = AudioCue.safeParse(raw);
      if (!r.success) throw schemaError(r.error.issues, `add[${i}]`, "audio cue");
      if (r.data.sound) resolveSound(r.data.sound, a.pack);
      if (r.data.asset && !scene.assets[r.data.asset]) throw new DwError("UNKNOWN_ASSET", `Asset '${r.data.asset}' is not in scene '${scene.id}'.`, { path: `add[${i}].asset` });
      a.cues.push(r.data);
    });
    a.cues.sort((x, y) => x.t - y.t);
  }
  if (opts.music === null) delete a.music;
  else if (opts.music) {
    const r = Music.safeParse({ ...(a.music ?? {}), ...opts.music });
    if (!r.success) throw schemaError(r.error.issues, "music", "music");
    if (!scene.assets[r.data.asset]) throw new DwError("UNKNOWN_ASSET", `Asset '${r.data.asset}' is not in scene '${scene.id}'.`, { path: "music.asset" });
    a.music = r.data;
  }
  return { ...scene, audio: a };
}

/* ------------------------------------------------------------------ mix plan */

export interface AudioClip {
  /** Absolute path of the audio (or video) file. */
  file: string;
  /** Where it starts in the output, seconds (≥ 0). */
  at: number;
  /** Seconds skipped at the start of the file (clips that began before the rendered range). */
  skip: number;
  gain: number;
  /** Music only: loop the file, fade in/out over the output. */
  loop?: boolean;
  fadeIn?: number;
  fadeOut?: number;
}

export interface AudioPlan {
  /** Output length, seconds. */
  duration: number;
  clips: AudioClip[];
}

/**
 * Turns the scene's audio into a list of clips for the rendered range [start, end). Returns null when
 * there is nothing to play. Pure: the renderer does the mixing with FFmpeg.
 */
export function buildAudioPlan(scene: Scene, range: { start: number; end: number }, resolveAssetPath: (path: string) => string): AudioPlan | null {
  const a = scene.audio;
  if (!a.enabled || a.volume <= 0) return null;
  const duration = range.end - range.start;
  const clips: AudioClip[] = [];
  for (const c of a.cues) {
    let file: string;
    let length: number;
    let weight = 1;
    if (c.sound) {
      const s = resolveSound(c.sound, a.pack);
      file = s.file;
      length = s.duration;
      // UI SFX files are all mastered to the same peak; defaultVolume says how loud each cue should sit.
      weight = Math.min(1.3, Math.max(0.4, s.defaultVolume / 0.2));
    } else {
      const asset = scene.assets[c.asset!];
      if (!asset) continue;
      file = resolveAssetPath(asset.path);
      length = asset.duration ?? Infinity;
    }
    const at = c.t - range.start;
    if (at >= duration || at + length <= 0 || c.gain <= 0) continue;
    clips.push({ file, at: Math.max(0, r3(at)), skip: Math.max(0, r3(-at)), gain: r3(c.gain * weight * a.volume) });
  }
  if (a.music && a.music.volume > 0) {
    const asset = scene.assets[a.music.asset];
    if (asset) {
      clips.push({
        file: resolveAssetPath(asset.path),
        at: 0,
        skip: r3(a.music.offset + range.start),
        gain: r3(a.music.volume * a.volume),
        loop: a.music.loop,
        fadeIn: range.start === 0 ? a.music.fadeIn : 0,
        fadeOut: a.music.fadeOut,
      });
    }
  }
  return clips.length ? { duration: r3(duration), clips } : null;
}
