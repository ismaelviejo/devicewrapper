import { existsSync } from "node:fs";
import { Scene, STILL_FORMATS, VIDEO_FORMATS, type Node } from "@devicewrapper/schema";
import { resolveDeviceColor, type DeviceRegistry } from "./devices.js";
import { formatPath, isDwError, type IssueDetail } from "./errors.js";
import { animatableProperties, checkValue, findTarget } from "./properties.js";
import { referencedVariables, substitute, variablesFor } from "./resolve.js";
import { SOUND_PACK_NAMES, resolveSound } from "./audio.js";
import { migrateScene } from "./store.js";
import type { Workspace } from "./workspace.js";

const GENERIC_FONTS = new Set(["system-ui", "sans-serif", "serif", "monospace", "cursive", "fantasy"]);

const SCRIPTS: Array<[string, RegExp]> = [
  ["Japanese/Chinese", /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/],
  ["Korean", /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/],
  ["Arabic", /[\u0600-\u06ff\u0750-\u077f\ufb50-\ufdff\ufe70-\ufeff]/],
  ["Hebrew", /[\u0590-\u05ff]/],
  ["Thai", /[\u0e00-\u0e7f]/],
  ["Indic", /[\u0900-\u0dff]/],
  ["emoji", /\p{Extended_Pictographic}/u],
];

/** Scripts in `text` that Inter (Latin, Cyrillic, Greek, Vietnamese) doesn't cover. */
export function scriptsNotInInter(text: string): string[] {
  return SCRIPTS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

export interface ValidationIssue extends IssueDetail {
  severity: "error" | "warning";
}

export interface ValidationReport {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

/** What the active renderer can draw. Features outside this set produce warnings, not silent fakes. */
export interface RendererCapabilities {
  backgrounds: ReadonlyArray<string>;
  screenSources: ReadonlyArray<string>;
  effects: ReadonlyArray<string>;
  /** Can mux sound into video renders. */
  audio?: boolean;
  depthOfField: boolean;
  text: boolean;
  video: boolean;
  fonts: ReadonlyArray<string>;
  stillFormats: ReadonlyArray<string>;
  videoFormats: ReadonlyArray<string>;
}

export interface ValidateContext {
  devices: DeviceRegistry;
  workspace?: Workspace;
  capabilities?: RendererCapabilities;
  /** Check that asset files exist on disk (default true when a workspace is given). */
  checkFiles?: boolean;
}

export function validateScene(input: unknown, ctx: ValidateContext): ValidationReport {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const err = (code: string, message: string, path?: string, hint?: string) => {
    const i: ValidationIssue = { severity: "error", code, message };
    if (path !== undefined) i.path = path;
    if (hint !== undefined) i.hint = hint;
    errors.push(i);
  };
  const warn = (code: string, message: string, path?: string, hint?: string) => {
    const i: ValidationIssue = { severity: "warning", code, message };
    if (path !== undefined) i.path = path;
    if (hint !== undefined) i.hint = hint;
    warnings.push(i);
  };

  let migrated: unknown;
  try {
    migrated = migrateScene(input);
  } catch (e) {
    if (isDwError(e)) err(e.code, e.message, e.path, e.hint);
    else err("SCHEMA_INVALID", String(e));
    return { valid: false, errors, warnings };
  }
  const parsed = Scene.safeParse(migrated);
  if (!parsed.success) {
    for (const i of parsed.error.issues) err("SCHEMA_INVALID", `${formatPath(i.path) || "(root)"}: ${i.message}`, formatPath(i.path));
    return { valid: false, errors, warnings };
  }
  const scene = parsed.data;
  const caps = ctx.capabilities;

  /* ids */
  const seen = new Map<string, string>();
  const claim = (id: string, where: string) => {
    if (id === "camera") err("RESERVED_ID", `'camera' is reserved for the scene camera.`, where);
    const prev = seen.get(id);
    if (prev) err("DUPLICATE_ID", `ID '${id}' is used by both ${prev} and ${where}. Nodes and lights share one namespace.`, where);
    else seen.set(id, where);
  };
  scene.nodes.forEach((n, i) => claim(n.id, `nodes[${i}]`));
  scene.lights.forEach((l, i) => claim(l.id, `lights[${i}]`));

  /* canvas & limits */
  const cfg = ctx.workspace?.config;
  if (cfg) {
    if (scene.canvas.width > cfg.maxWidth || scene.canvas.height > cfg.maxHeight) {
      err("RESOLUTION_TOO_LARGE", `Canvas ${scene.canvas.width}x${scene.canvas.height} exceeds the configured maximum ${cfg.maxWidth}x${cfg.maxHeight}.`, "canvas");
    }
    if (scene.canvas.duration > cfg.maxDuration) {
      err("DURATION_TOO_LONG", `Duration ${scene.canvas.duration}s exceeds the configured maximum ${cfg.maxDuration}s.`, "canvas.duration");
    }
  }
  if (scene.canvas.width % 2 || scene.canvas.height % 2) {
    warn("ODD_DIMENSIONS", `Canvas ${scene.canvas.width}x${scene.canvas.height} has an odd dimension; H.264 video needs even sizes and will be padded by 1px.`, "canvas");
  }

  /* camera */
  const c = scene.camera;
  if (c.position.every((v, k) => Math.abs(v - c.target[k]!) < 1e-9)) err("INVALID_CAMERA", "Camera position equals its target; the view direction is undefined.", "camera.position");
  if (c.near >= c.far) err("INVALID_CAMERA", `camera.near (${c.near}) must be less than camera.far (${c.far}).`, "camera.near");
  if (c.dof.enabled && caps && !caps.depthOfField) warn("NOT_RENDERED", "Depth of field is enabled but the current renderer does not draw it yet.", "camera.dof");

  /* nodes */
  const nodeById = new Map<string, Node>(scene.nodes.map((n) => [n.id, n]));
  const assetUse = (assetId: string, expect: "image" | "video", path: string) => {
    const a = scene.assets[assetId];
    if (!a) {
      err("UNKNOWN_ASSET", `Asset '${assetId}' is not in scene.assets.`, path, `Import it first with import_asset. Known assets: ${Object.keys(scene.assets).join(", ") || "(none)"}.`);
      return;
    }
    if (a.type !== expect) err("ASSET_TYPE_MISMATCH", `Asset '${assetId}' is a ${a.type}, but ${path} needs a ${expect}.`, path);
  };
  const materialUse = (ref: unknown, path: string) => {
    if (typeof ref === "string" && !scene.materials[ref]) {
      err("UNKNOWN_MATERIAL", `Material '${ref}' is not defined in scene.materials.`, path, `Defined: ${Object.keys(scene.materials).join(", ") || "(none)"}.`);
    }
  };

  scene.nodes.forEach((n, i) => {
    const p = `nodes[${i}]`;
    if (n.kind !== "text2d" && n.parent !== undefined) {
      const parent = nodeById.get(n.parent);
      if (!parent) err("UNKNOWN_PARENT", `Node '${n.id}' has parent '${n.parent}', which does not exist.`, `${p}.parent`);
      else if (parent.kind === "text2d") err("INVALID_PARENT", `Node '${n.id}' cannot be a child of text node '${parent.id}'.`, `${p}.parent`);
      else {
        let cur: string | undefined = n.parent;
        const chain = new Set([n.id]);
        while (cur) {
          if (chain.has(cur)) {
            err("PARENT_CYCLE", `Node '${n.id}' is in a parent cycle.`, `${p}.parent`);
            break;
          }
          chain.add(cur);
          const pn = nodeById.get(cur);
          cur = pn && pn.kind !== "text2d" ? pn.parent : undefined;
        }
      }
    }
    switch (n.kind) {
      case "device": {
        const def = ctx.devices.get(n.model);
        if (!def) err("UNKNOWN_DEVICE_MODEL", `Unknown device model '${n.model}'. Available: ${ctx.devices.ids().join(", ")}.`, `${p}.model`);
        else if (!resolveDeviceColor(def, n.color)) {
          err("UNKNOWN_DEVICE_COLOR", `Model '${def.id}' has no color '${n.color}'. Use ${def.colors.map((x) => x.name).join(", ")} or a hex color.`, `${p}.color`);
        }
        if (n.material !== undefined) materialUse(n.material, `${p}.material`);
        const src = n.screen.source;
        if (src.type !== "color") {
          assetUse(src.asset, src.type, `${p}.screen.source.asset`);
          if (caps && !caps.screenSources.includes(src.type)) {
            warn("NOT_RENDERED", `Screen source type '${src.type}' on '${n.id}' is not supported by the current renderer yet; the screen will show its background color.`, `${p}.screen.source`);
          }
        }
        break;
      }
      case "plane":
      case "primitive": {
        materialUse(n.material, `${p}.material`);
        const mat = typeof n.material === "string" ? scene.materials[n.material] : n.material;
        if (mat?.type === "reflective" && n.kind !== "plane") {
          warn("NOT_RENDERED", `Reflective material on primitive '${n.id}' is drawn as a shadow-only surface; reflections work on planes only.`, `${p}.material`);
        }
        break;
      }
      case "text2d": {
        const known = new Set(["locale", ...Object.keys(scene.variables)]);
        for (const v of referencedVariables(n.content)) {
          if (!known.has(v)) warn("UNDEFINED_VARIABLE", `Text '${n.id}' uses {{${v}}}, which has no base value in scene.variables.`, `${p}.content`, "Set it with set_variables.");
          for (const [loc, dict] of Object.entries(scene.locales)) {
            if (!(v in dict) && !known.has(v)) warn("MISSING_TRANSLATION", `Locale '${loc}' has no value for {{${v}}} used by '${n.id}'.`, `locales.${loc}`);
          }
        }
        const fontAssets = new Set(Object.entries(scene.assets).filter(([, a]) => a.type === "font").map(([id]) => id));
        if (caps && !caps.text) warn("NOT_RENDERED", `Text node '${n.id}' will not be drawn: the current renderer has no text support yet.`, p);
        else if (caps && !caps.fonts.includes(n.font) && !GENERIC_FONTS.has(n.font) && !fontAssets.has(n.font)) {
          warn("UNKNOWN_FONT", `Font '${n.font}' is neither bundled (${caps.fonts.join(", ")}) nor an imported font asset; Inter or a system font will be used.`, `${p}.font`, "Import a TTF/OTF/WOFF with import_asset and set font to its asset ID.");
        }
        if (caps?.text && !fontAssets.has(n.font)) {
          const texts = [substitute(n.content, variablesFor(scene)), ...Object.keys(scene.locales).map((loc) => substitute(n.content, variablesFor(scene, loc)))];
          const scripts = new Set(texts.flatMap((t) => scriptsNotInInter(t)));
          if (scripts.size) {
            warn("SYSTEM_FONT_FALLBACK", `Text '${n.id}' contains ${[...scripts].join(", ")} characters, which the bundled Inter font doesn't cover; they'll use this machine's system fonts, so they may look different on another machine.`, `${p}.content`, "For consistent output, import a font that covers these scripts (e.g. Noto Sans JP) and set font to its asset ID.");
          }
        }
        break;
      }
      default:
        break;
    }
  });

  /* background */
  const bg = scene.background;
  if (bg.type === "image" || bg.type === "video") assetUse(bg.asset, bg.type, "background.asset");
  if (caps && !caps.backgrounds.includes(bg.type)) warn("NOT_RENDERED", `Background type '${bg.type}' is not supported by the current renderer yet.`, "background");
  if (bg.type === "gradient") {
    for (let k = 1; k < bg.stops.length; k++) {
      if (bg.stops[k]!.offset < bg.stops[k - 1]!.offset) {
        warn("UNSORTED_GRADIENT", "Gradient stops are not in ascending offset order; they will be sorted.", "background.stops");
        break;
      }
    }
  }

  /* effects */
  const effectTypes = new Set<string>();
  scene.effects.forEach((e, i) => {
    if (effectTypes.has(e.type)) warn("DUPLICATE_EFFECT", `Effect '${e.type}' appears more than once; only the last is used.`, `effects[${i}]`);
    effectTypes.add(e.type);
    if (caps && !caps.effects.includes(e.type)) warn("NOT_RENDERED", `Effect '${e.type}' is not supported by the current renderer yet.`, `effects[${i}]`);
  });

  /* audio */
  const au = scene.audio;
  if (!SOUND_PACK_NAMES.includes(au.pack)) err("UNKNOWN_SOUND_PACK", `Sound pack '${au.pack}' does not exist. Packs: ${SOUND_PACK_NAMES.join(", ")}.`, "audio.pack");
  au.cues.forEach((c, i) => {
    const p = `audio.cues[${i}]`;
    if (c.sound) {
      try {
        resolveSound(c.sound, SOUND_PACK_NAMES.includes(au.pack) ? au.pack : "minimal");
      } catch (e) {
        if (isDwError(e)) err(e.code, e.message, `${p}.sound`, e.hint);
      }
    } else if (c.asset) {
      const a = scene.assets[c.asset];
      if (!a) err("UNKNOWN_ASSET", `Audio cue uses asset '${c.asset}', which is not in scene.assets.`, `${p}.asset`, "Import it with set_audio (pass a file path) or import_asset.");
      else if (a.type !== "audio" && a.type !== "video") err("ASSET_TYPE_MISMATCH", `Asset '${c.asset}' is a ${a.type}; audio cues need an audio file.`, `${p}.asset`);
    }
    if (c.t >= scene.canvas.duration) warn("CUE_AFTER_END", `Sound at ${c.t}s starts after the timeline ends (${scene.canvas.duration}s) and won't be heard.`, `${p}.t`);
  });
  if (au.music) {
    const a = scene.assets[au.music.asset];
    if (!a) err("UNKNOWN_ASSET", `Music uses asset '${au.music.asset}', which is not in scene.assets.`, "audio.music.asset");
    else if (a.type !== "audio" && a.type !== "video") err("ASSET_TYPE_MISMATCH", `Asset '${au.music.asset}' is a ${a.type}; music needs an audio file.`, "audio.music.asset");
  }
  if (caps && caps.audio === false && au.enabled && (au.cues.length || au.music)) warn("NOT_RENDERED", "The scene has sound, but the current renderer can't add audio to videos.", "audio");

  /* assets on disk */
  if (ctx.workspace && ctx.checkFiles !== false) {
    for (const [id, a] of Object.entries(scene.assets)) {
      try {
        ctx.workspace.resolveRead(a.path, `Asset '${id}'`);
      } catch (e) {
        if (isDwError(e)) err(e.code === "FILE_NOT_FOUND" ? "ASSET_FILE_MISSING" : e.code, e.message, `assets.${id}.path`, e.hint);
      }
    }
  } else if (ctx.checkFiles) {
    for (const [id, a] of Object.entries(scene.assets)) {
      if (!existsSync(a.path)) err("ASSET_FILE_MISSING", `Asset '${id}' file ${a.path} does not exist.`, `assets.${id}.path`);
    }
  }

  /* animation */
  const trackKeys = new Set<string>();
  scene.animation.tracks.forEach((t, i) => {
    const p = `animation.tracks[${i}]`;
    const key = `${t.target}::${t.property}`;
    if (trackKeys.has(key)) err("DUPLICATE_TRACK", `Two tracks animate '${t.property}' on '${t.target}'.`, p);
    trackKeys.add(key);
    const ref = findTarget(scene, t.target);
    if (!ref) {
      err("UNKNOWN_TRACK_TARGET", `Track targets '${t.target}', which is not a node, light or 'camera'.`, `${p}.target`);
      return;
    }
    const props = animatableProperties(ref);
    const spec = props[t.property];
    if (!spec) {
      err("INVALID_TRACK_PROPERTY", `'${t.property}' is not animatable on '${t.target}'. Animatable: ${Object.keys(props).join(", ")}.`, `${p}.property`);
      return;
    }
    if (t.interpolation === "slerp" && spec.kind !== "rotation") err("INVALID_INTERPOLATION", "'slerp' only applies to rotation tracks.", `${p}.interpolation`);
    const times = new Set<number>();
    t.keyframes.forEach((k, j) => {
      const reason = checkValue(spec, k.value);
      if (reason) err("INVALID_KEYFRAME_VALUE", `Keyframe value for '${t.property}' ${reason} (got ${JSON.stringify(k.value)}).`, `${p}.keyframes[${j}].value`);
      if (times.has(k.t)) err("DUPLICATE_KEYFRAME_TIME", `Two keyframes at t=${k.t}s.`, `${p}.keyframes[${j}].t`);
      times.add(k.t);
      if (k.t > scene.canvas.duration) {
        warn("KEYFRAME_AFTER_END", `Keyframe at t=${k.t}s is after the timeline end (${scene.canvas.duration}s) and will never be reached.`, `${p}.keyframes[${j}].t`, "Increase canvas.duration with update_scene, or move the keyframe.");
      }
    });
  });

  /* localization */
  if (Object.keys(scene.locales).length && !(scene.defaultLocale in scene.locales) && Object.keys(scene.variables).length === 0) {
    warn("DEFAULT_LOCALE_EMPTY", `defaultLocale '${scene.defaultLocale}' has no values and there are no base variables.`, "defaultLocale");
  }

  /* render */
  const fmt = scene.render.format;
  if (caps) {
    const isVideo = (VIDEO_FORMATS as readonly string[]).includes(fmt);
    const supported = isVideo ? caps.videoFormats : caps.stillFormats;
    if (!supported.includes(fmt)) warn("NOT_RENDERED", `Default render format '${fmt}' is not supported by the current renderer yet.`, "render.format");
  }
  if (scene.render.transparent && (fmt === "jpeg" || fmt === "mp4")) {
    warn("NO_ALPHA", `Format '${fmt}' cannot store transparency; use png/webp for stills or webm/mov for video.`, "render.transparent");
  }
  if (!([...STILL_FORMATS] as string[]).includes(fmt) && scene.canvas.duration === 0) {
    err("ZERO_DURATION", "Video format selected but canvas.duration is 0.", "canvas.duration");
  }

  return { valid: errors.length === 0, errors, warnings };
}
