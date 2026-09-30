/**
 * In-browser scene builder. Runs inside headless Chromium, draws a FrameState with Three.js,
 * composites the 2D layers (background, vignette, grain, text) and returns a PNG.
 * It never reads the clock: everything comes from the payloads Node sends.
 */
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import type { FrameState, LightFrame, NodeFrame } from "@devicewrapper/core";
import type { DeviceDefinition, Light, Material } from "@devicewrapper/schema";
import type { LoadPayload, PageApi, PageBackground, PageDevice, PageLimits, PageNode, PageText, RenderFrameOptions } from "../src/protocol.js";

const DEG = Math.PI / 180;
const DEBUG_TIMING = new URLSearchParams(location.search).has("debug");

/* ------------------------------------------------------------ renderer */

const glCanvas = document.createElement("canvas");
const renderer = new THREE.WebGLRenderer({
  canvas: glCanvas,
  antialias: true,
  alpha: true,
  premultipliedAlpha: true,
  preserveDrawingBuffer: true,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.VSMShadowMap;
renderer.setClearColor(0x000000, 0);

const composite = document.createElement("canvas");
const ctx2d = composite.getContext("2d", { alpha: true, willReadFrequently: true })!;

const pmrem = new THREE.PMREMGenerator(renderer);
const envCache = new Map<string, THREE.Texture>();
function environmentTexture(preset: string): THREE.Texture | null {
  if (preset === "none") return null;
  let t = envCache.get(preset);
  if (!t) {
    const room = new RoomEnvironment();
    t = pmrem.fromScene(room, preset === "soft" ? 0.12 : 0.04).texture;
    envCache.set(preset, t);
  }
  return t;
}

/* ------------------------------------------------------------- helpers */

function roundedRect(w: number, h: number, r: number): THREE.Shape {
  const rr = Math.max(1e-6, Math.min(r, w / 2 - 1e-6, h / 2 - 1e-6));
  const s = new THREE.Shape();
  const x0 = -w / 2, x1 = w / 2, y0 = -h / 2, y1 = h / 2;
  s.moveTo(x0 + rr, y0);
  s.lineTo(x1 - rr, y0);
  s.absarc(x1 - rr, y0 + rr, rr, -Math.PI / 2, 0, false);
  s.lineTo(x1, y1 - rr);
  s.absarc(x1 - rr, y1 - rr, rr, 0, Math.PI / 2, false);
  s.lineTo(x0 + rr, y1);
  s.absarc(x0 + rr, y1 - rr, rr, Math.PI / 2, Math.PI, false);
  s.lineTo(x0, y0 + rr);
  s.absarc(x0 + rr, y0 + rr, rr, Math.PI, Math.PI * 1.5, false);
  return s;
}

/** Flat rounded rectangle with UVs normalized to 0..1 over its bounds. */
function roundedRectFlat(w: number, h: number, r: number, segments = 32): THREE.BufferGeometry {
  const g = new THREE.ShapeGeometry(roundedRect(w, h, r), segments);
  const pos = g.attributes.position!;
  const uv = g.attributes.uv!;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) + w / 2) / w, (pos.getY(i) + h / 2) / h);
  uv.needsUpdate = true;
  return g;
}

/** Rounded slab (rounded rect in XY, rounded edges in Z) spanning z in [-d/2, d/2]. */
function roundedSlab(w: number, h: number, d: number, r: number, e: number, curveSegments = 36): THREE.BufferGeometry {
  const edge = Math.max(0, Math.min(e, d / 2 - 1e-5, w / 4, h / 4));
  const inner = roundedRect(w - 2 * edge, h - 2 * edge, Math.max(r - edge, 1e-5));
  const depth = Math.max(d - 2 * edge, 1e-5);
  const g = new THREE.ExtrudeGeometry(inner, {
    depth,
    bevelEnabled: edge > 0,
    bevelThickness: edge,
    bevelSize: edge,
    bevelOffset: 0,
    bevelSegments: edge > 0 ? 6 : 0,
    curveSegments,
  });
  g.translate(0, 0, -depth / 2);
  g.computeVertexNormals();
  return g;
}

function color(hex: string): THREE.Color {
  return new THREE.Color(hex.slice(0, 7));
}

function alphaOf(hex: string): number {
  return hex.length === 9 ? parseInt(hex.slice(7, 9), 16) / 255 : 1;
}

function makeMaterial(m: Material): THREE.Material {
  switch (m.type) {
    case "pbr": {
      const mat = new THREE.MeshPhysicalMaterial({
        color: color(m.color),
        roughness: m.roughness,
        metalness: m.metalness,
        emissive: color(m.emissive),
        emissiveIntensity: m.emissiveIntensity,
        clearcoat: m.clearcoat,
        clearcoatRoughness: m.clearcoatRoughness,
        opacity: m.opacity,
        transparent: m.opacity < 1,
      });
      mat.userData.baseOpacity = m.opacity;
      return mat;
    }
    case "shadowCatcher": {
      const mat = new THREE.ShadowMaterial({ color: color(m.color), opacity: m.opacity, transparent: true });
      mat.userData.baseOpacity = m.opacity;
      return mat;
    }
    case "unlit": {
      const mat = new THREE.MeshBasicMaterial({ color: color(m.color), opacity: m.opacity, transparent: m.opacity < 1 });
      mat.userData.baseOpacity = m.opacity;
      return mat;
    }
  }
}

const FINISH: Record<PageDevice["finish"], { metalness: number; roughness: number; clearcoat: number; clearcoatRoughness: number }> = {
  metal: { metalness: 0.78, roughness: 0.34, clearcoat: 0, clearcoatRoughness: 0.2 },
  matte: { metalness: 0.0, roughness: 0.58, clearcoat: 0.15, clearcoatRoughness: 0.5 },
  glossy: { metalness: 0.15, roughness: 0.16, clearcoat: 1, clearcoatRoughness: 0.05 },
};

/* ------------------------------------------------------------- textures */

const textureCache = new Map<string, THREE.Texture>();
async function loadTexture(url: string): Promise<THREE.Texture> {
  let t = textureCache.get(url);
  if (t) return t;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Texture ${url}: HTTP ${res.status}`);
  const bitmap = await createImageBitmap(await res.blob(), { imageOrientation: "flipY", premultiplyAlpha: "none", colorSpaceConversion: "none" });
  t = new THREE.Texture(bitmap as unknown as HTMLImageElement);
  t.flipY = false;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  textureCache.set(url, t);
  return t;
}

const bitmapCache = new Map<string, ImageBitmap>();
async function loadBitmap(url: string): Promise<ImageBitmap> {
  let b = bitmapCache.get(url);
  if (b) return b;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Image ${url}: HTTP ${res.status}`);
  b = await createImageBitmap(await res.blob(), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  bitmapCache.set(url, b);
  if (bitmapCache.size > 8) {
    const first = bitmapCache.keys().next().value!;
    bitmapCache.get(first)?.close();
    bitmapCache.delete(first);
  }
  return b;
}

/** Per-node video frame textures: replaced (and the old one freed) on every frame change. */
const videoTextures = new Map<string, { url: string; tex: THREE.Texture }>();
async function loadFrameTexture(url: string): Promise<THREE.Texture> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Frame ${url}: HTTP ${res.status}`);
  const bitmap = await createImageBitmap(await res.blob(), { imageOrientation: "flipY", premultiplyAlpha: "none", colorSpaceConversion: "none" });
  const t = new THREE.Texture(bitmap as unknown as HTMLImageElement);
  t.flipY = false;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return t;
}

/* --------------------------------------------------------------- devices */

const geometryCache = new Map<string, THREE.BufferGeometry>();
function cachedGeometry(key: unknown, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  const k = JSON.stringify(key);
  let g = geometryCache.get(k);
  if (!g) {
    g = make();
    geometryCache.set(k, g);
  }
  return g;
}

interface DeviceParts {
  group: THREE.Group;
  screenMaterial: THREE.MeshBasicMaterial;
  glareMaterial: THREE.MeshStandardMaterial;
  /** Laptops: the lid pivot, rotated by lidAngle each frame. */
  lid?: THREE.Object3D;
  defaultLidAngle?: number;
}

function bodyMaterialFor(n: PageDevice): THREE.Material {
  if (n.bodyMaterial) return makeMaterial(n.bodyMaterial);
  return new THREE.MeshPhysicalMaterial({ color: color(n.bodyColor), ...FINISH[n.finish] });
}

function accentColor(n: PageDevice, fallback: string): string {
  const variant = n.def.colors.find((c) => c.body.toLowerCase() === n.bodyColor.toLowerCase());
  return variant?.accent ?? fallback;
}

/**
 * Glass, screen, cutout and glare layers on a flat face at z = faceZ (facing +z) of `parent`.
 * `face` is the glass area; the screen sits at `centerY + def.screen.offset`.
 */
async function addScreen(parent: THREE.Object3D, n: PageDevice, face: { w: number; h: number; r: number; centerY: number }, faceZ: number): Promise<{ screenMaterial: THREE.MeshBasicMaterial; glareMaterial: THREE.MeshStandardMaterial }> {
  const def = n.def;
  const glassGeo = cachedGeometry(["glass", face.w, face.h, face.r], () => roundedRectFlat(face.w, face.h, face.r, 48));
  const glass = new THREE.Mesh(
    glassGeo,
    new THREE.MeshPhysicalMaterial({ color: color(def.bezelColor), roughness: 0.06, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 }),
  );
  glass.position.set(0, face.centerY, faceZ + 0.00004);
  parent.add(glass);

  // Screen: unlit, so screenshots keep their exact colors. Glare is a separate additive glass layer
  // (specular only), scaled by `glare`, so reflections never wash out the UI.
  const screenMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8 });
  if (n.screenUrl) screenMaterial.map = await loadTexture(n.screenUrl);
  else screenMaterial.color = color(n.screenColor);
  screenMaterial.userData.baseColor = screenMaterial.color.clone();
  const s = def.screen;
  const screen = new THREE.Mesh(cachedGeometry(["screen", s.width, s.height, s.cornerRadius], () => roundedRectFlat(s.width, s.height, s.cornerRadius, 48)), screenMaterial);
  screen.position.set(s.offset[0], face.centerY + s.offset[1], faceZ + 0.00008);
  screen.name = "screen";
  parent.add(screen);

  if (def.cutout) {
    const c = def.cutout;
    const geo = cachedGeometry(["cutout", c], () =>
      c.type === "punch" ? new THREE.CircleGeometry(c.width / 2, 48) : roundedRectFlat(c.width, c.height, c.type === "island" ? c.height / 2 : c.height * 0.45, 24),
    );
    const cut = new THREE.Mesh(geo, new THREE.MeshPhysicalMaterial({ color: 0x010101, roughness: 0.1, clearcoat: 1, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -12 }));
    const top = face.centerY + s.offset[1] + s.height / 2;
    cut.position.set(s.offset[0], top - c.offsetY - c.height / 2, faceZ + 0.00012);
    parent.add(cut);
  }

  const glareMaterial = new THREE.MeshStandardMaterial({
    color: 0x000000,
    roughness: 0.05,
    metalness: 0,
    envMapIntensity: 1.6,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    opacity: 0.25,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -16,
  });
  glareMaterial.userData.isGlare = true;
  const glare = new THREE.Mesh(glassGeo, glareMaterial);
  glare.position.set(0, face.centerY, faceZ + 0.00016);
  glare.renderOrder = 2;
  parent.add(glare);
  return { screenMaterial, glareMaterial };
}

function shadowed<T extends THREE.Mesh>(m: T, n: PageDevice): T {
  m.castShadow = n.castShadow;
  m.receiveShadow = n.receiveShadow;
  return m;
}

async function buildSlab(n: PageDevice, def: Extract<PageDevice["def"], { form: "slab" }>): Promise<DeviceParts> {
  const { width: w, height: h, depth: d, cornerRadius: r, edgeRadius: e } = def.body;
  const edge = Math.max(0, Math.min(e, d / 2 - 1e-5));
  const group = new THREE.Group();
  const bodyMat = bodyMaterialFor(n);
  group.add(shadowed(new THREE.Mesh(cachedGeometry(["slab", def.body], () => roundedSlab(w, h, d, r, edge)), bodyMat), n));
  const screen = await addScreen(group, n, { w: w - 2 * edge, h: h - 2 * edge, r: Math.max(r - edge, 1e-5), centerY: 0 }, d / 2);

  if (def.cameraBump) {
    const b = def.cameraBump;
    const be = Math.min(0.0006, b.depth / 2);
    const bumpMat = bodyMat.clone();
    if (bumpMat instanceof THREE.MeshPhysicalMaterial) bumpMat.roughness = Math.max(0.08, bumpMat.roughness - 0.12);
    const bumpDepth = b.depth + 0.0006;
    const bump = shadowed(new THREE.Mesh(cachedGeometry(["bump", b], () => roundedSlab(b.width, b.height, bumpDepth, b.cornerRadius, be, 32)), bumpMat), n);
    // Seen from the back, +x is to the viewer's right, which is -x in device space.
    const bx = -b.position[0], by = b.position[1];
    bump.position.set(bx, by, -d / 2 - bumpDepth / 2 + 0.0006);
    group.add(bump);
    const back = -d / 2 - b.depth;
    const ringGeo = cachedGeometry(["lensRing"], () => new THREE.CylinderGeometry(0.5, 0.5, 1, 64).rotateX(Math.PI / 2));
    const lensGeo = cachedGeometry(["lensGlass"], () => new THREE.CircleGeometry(0.5, 64));
    const ringMat = new THREE.MeshPhysicalMaterial({ color: 0x9a9ba0, metalness: 1, roughness: 0.22 });
    const lensMat = new THREE.MeshPhysicalMaterial({ color: 0x0b0e16, metalness: 0.2, roughness: 0.03, clearcoat: 1, clearcoatRoughness: 0.02, iridescence: 0.6, iridescenceIOR: 1.6, iridescenceThicknessRange: [200, 500] });
    for (const lens of b.lenses) {
      const lx = bx - lens.position[0], ly = by + lens.position[1];
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.scale.set(lens.diameter, lens.diameter, 0.0009);
      ring.position.set(lx, ly, back - 0.00045 + 0.0002);
      group.add(ring);
      const glassLens = new THREE.Mesh(lensGeo, lensMat);
      glassLens.scale.setScalar(lens.diameter * 0.78);
      glassLens.rotation.y = Math.PI;
      glassLens.position.set(lx, ly, back - 0.0009 + 0.0002 - 0.00002);
      group.add(glassLens);
    }
  }
  for (const btn of def.buttons) {
    const size: [number, number, number] = [btn.protrusion * 2, btn.length, btn.thickness];
    const m = shadowed(new THREE.Mesh(cachedGeometry(["btn", size], () => new RoundedBoxGeometry(size[0], size[1], size[2], 2, Math.min(...size) * 0.45)), bodyMat), n);
    m.position.set(btn.side === "left" ? -w / 2 : w / 2, h / 2 - btn.offsetY, 0);
    group.add(m);
  }
  return { group, ...screen };
}

/** Procedural keyboard texture: key caps on a dark deck. Deterministic (pure drawing). */
function keyboardTexture(deck: string, keys: string): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 400;
  const g = c.getContext("2d")!;
  g.fillStyle = deck;
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = keys;
  const rows = [
    { n: 14, h: 0.55 },
    { n: 14, h: 1 },
    { n: 14, h: 1 },
    { n: 13, h: 1 },
    { n: 12, h: 1 },
    { n: 10, h: 1 },
  ];
  const pad = 10, gap = 8;
  const unitH = (c.height - 2 * pad - gap * (rows.length - 1)) / rows.reduce((a, r) => a + r.h, 0);
  let y = pad;
  rows.forEach((row, ri) => {
    const hgt = unitH * row.h;
    const widths = Array.from({ length: row.n }, (_, i) => (ri === 5 && i === 4 ? 5 : ri >= 2 && (i === 0 || i === row.n - 1) ? 1.6 : 1));
    const total = widths.reduce((a, b) => a + b, 0);
    const unitW = (c.width - 2 * pad - gap * (row.n - 1)) / total;
    let x = pad;
    for (const wu of widths) {
      const kw = unitW * wu;
      g.beginPath();
      g.roundRect(x, y, kw, hgt, 7);
      g.fill();
      x += kw + gap;
    }
    y += hgt + gap;
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}

async function buildLaptop(n: PageDevice, def: Extract<PageDevice["def"], { form: "laptop" }>): Promise<DeviceParts> {
  const { base, lid } = def;
  const group = new THREE.Group();
  const bodyMat = bodyMaterialFor(n);
  // Base: a rounded slab lying flat (its outline in XZ), centered on the origin.
  const baseGeo = cachedGeometry(["laptopBase", base], () => roundedSlab(base.width, base.depth, base.thickness, base.cornerRadius, Math.min(base.edgeRadius, base.thickness / 2 - 1e-5)).rotateX(-Math.PI / 2));
  group.add(shadowed(new THREE.Mesh(baseGeo, bodyMat), n));

  const top = base.thickness / 2;
  const accent = accentColor(n, "#111114");
  const kb = new THREE.Mesh(
    cachedGeometry(["kb", def.keyboard], () => roundedRectFlat(def.keyboard.width, def.keyboard.depth, 0.004, 16).rotateX(-Math.PI / 2)),
    new THREE.MeshStandardMaterial({ map: keyboardTexture(accent, "#" + color(accent).offsetHSL(0, 0, 0.035).getHexString()), roughness: 0.75, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 }),
  );
  kb.position.set(0, top + 0.00005, def.keyboard.offset);
  group.add(kb);
  const tpMat = bodyMat.clone();
  if (tpMat instanceof THREE.MeshPhysicalMaterial) {
    tpMat.roughness = Math.min(1, tpMat.roughness + 0.12);
    tpMat.polygonOffset = true;
    tpMat.polygonOffsetFactor = -1;
    tpMat.polygonOffsetUnits = -4;
  }
  const tp = new THREE.Mesh(cachedGeometry(["tp", def.trackpad], () => roundedRectFlat(def.trackpad.width, def.trackpad.depth, 0.006, 16).rotateX(-Math.PI / 2)), tpMat);
  tp.position.set(0, top + 0.00005, def.trackpad.offset);
  group.add(tp);

  // Lid: pivots on the hinge at the back top edge of the base. Inner face (screen) at z = 0 of the pivot.
  const pivot = new THREE.Group();
  pivot.position.set(0, top, -base.depth / 2);
  group.add(pivot);
  const le = Math.min(lid.edgeRadius, lid.thickness / 2 - 1e-5);
  const lidMesh = shadowed(new THREE.Mesh(cachedGeometry(["lid", lid, base.width], () => roundedSlab(base.width, lid.height, lid.thickness, lid.cornerRadius, le)), bodyMat), n);
  lidMesh.position.set(0, lid.height / 2, -lid.thickness / 2);
  pivot.add(lidMesh);
  const screen = await addScreen(pivot, n, { w: base.width - 2 * le, h: lid.height - 2 * le, r: Math.max(lid.cornerRadius - le, 1e-5), centerY: lid.height / 2 }, 0);
  return { group, ...screen, lid: pivot, defaultLidAngle: def.defaultLidAngle };
}

async function buildMonitor(n: PageDevice, def: Extract<PageDevice["def"], { form: "monitor" }>): Promise<DeviceParts> {
  const { width: w, height: h, depth: d, cornerRadius: r, edgeRadius: e } = def.body;
  const edge = Math.max(0, Math.min(e, d / 2 - 1e-5));
  const st = def.stand;
  const group = new THREE.Group();
  const bodyMat = bodyMaterialFor(n);
  group.add(shadowed(new THREE.Mesh(cachedGeometry(["panel", def.body], () => roundedSlab(w, h, d, r, edge)), bodyMat), n));
  const screen = await addScreen(group, n, { w: w - 2 * edge, h: h - 2 * edge, r: Math.max(r - edge, 1e-5), centerY: 0 }, d / 2);
  const footTop = -h / 2 - st.neckHeight;
  const neckTop = st.neckAttach;
  const neckLen = neckTop - footTop;
  const neckZ = -d / 2 - st.neckDepth / 2 - 0.004;
  const neck = shadowed(new THREE.Mesh(cachedGeometry(["neck", st, neckLen], () => new RoundedBoxGeometry(st.neckWidth, neckLen, st.neckDepth, 4, Math.min(st.neckDepth / 2 - 1e-4, 0.004))), bodyMat), n);
  neck.position.set(0, footTop + neckLen / 2, neckZ);
  group.add(neck);
  const footGeo = cachedGeometry(["foot", st], () => roundedSlab(st.footWidth, st.footDepth, st.footThickness, 0.02, Math.min(0.002, st.footThickness / 2 - 1e-5)).rotateX(-Math.PI / 2));
  const foot = shadowed(new THREE.Mesh(footGeo, bodyMat), n);
  foot.position.set(0, footTop - st.footThickness / 2, neckZ + st.footDepth * 0.2);
  group.add(foot);
  return { group, ...screen };
}

async function buildWatch(n: PageDevice, def: Extract<PageDevice["def"], { form: "watch" }>): Promise<DeviceParts> {
  const { width: w, height: h, depth: d, cornerRadius: r, edgeRadius: e } = def.body;
  const edge = Math.max(0, Math.min(e, d / 2 - 1e-5));
  const group = new THREE.Group();
  const bodyMat = bodyMaterialFor(n);
  group.add(shadowed(new THREE.Mesh(cachedGeometry(["watch", def.body], () => roundedSlab(w, h, d, r, edge)), bodyMat), n));
  const screen = await addScreen(group, n, { w: w - 2 * edge, h: h - 2 * edge, r: Math.max(r - edge, 1e-5), centerY: 0 }, d / 2);
  const crown = shadowed(new THREE.Mesh(cachedGeometry(["crown", def.crown], () => new THREE.CylinderGeometry(def.crown.diameter / 2, def.crown.diameter / 2, def.crown.length, 32).rotateZ(Math.PI / 2)), bodyMat), n);
  crown.position.set(w / 2 + def.crown.length / 2 - 0.0003, h / 2 - def.crown.offsetY, 0);
  group.add(crown);

  // Band: each strap is a chain of segments bending back from the case.
  const band = def.band;
  const bandMat = new THREE.MeshPhysicalMaterial({ color: color(accentColor(n, "#202226")), roughness: 0.7, metalness: 0, clearcoat: 0.2 });
  const segments = 10;
  const segLen = band.length / segments;
  const segGeo = cachedGeometry(["bandSeg", band], () => new RoundedBoxGeometry(band.width, segLen * 1.04, band.thickness, 3, band.thickness * 0.45));
  for (const dir of [1, -1]) {
    const root = new THREE.Group();
    root.position.set(0, (dir * h) / 2 - dir * 0.0035, -d / 2 + band.thickness * 0.6);
    if (dir < 0) root.rotation.z = Math.PI;
    group.add(root);
    let pivot: THREE.Object3D = root;
    for (let i = 0; i < segments; i++) {
      const joint = new THREE.Group();
      joint.rotation.x = -((band.curl * DEG) / segments);
      pivot.add(joint);
      const seg = shadowed(new THREE.Mesh(segGeo, bandMat), n);
      seg.position.y = segLen / 2;
      joint.add(seg);
      const next = new THREE.Group();
      next.position.y = segLen;
      joint.add(next);
      pivot = next;
    }
  }
  return { group, ...screen };
}

async function buildDevice(n: PageDevice): Promise<DeviceParts> {
  const def = n.def;
  switch (def.form) {
    case "slab":
      return buildSlab(n, def);
    case "laptop":
      return buildLaptop(n, def);
    case "monitor":
      return buildMonitor(n, def);
    case "watch":
      return buildWatch(n, def);
  }
}

/* ----------------------------------------------------------- primitives */

function primitiveGeometry(shape: string, size: [number, number, number], cornerRadius: number): THREE.BufferGeometry {
  const [a, b, c] = size;
  switch (shape) {
    case "box":
      return cornerRadius > 0 ? new RoundedBoxGeometry(a, b, c, 4, Math.min(cornerRadius, a / 2, b / 2, c / 2)) : new THREE.BoxGeometry(a, b, c);
    case "sphere":
      return new THREE.SphereGeometry(a / 2, 64, 32);
    case "cylinder":
      return new THREE.CylinderGeometry(a / 2, a / 2, b, 64);
    case "cone":
      return new THREE.ConeGeometry(a / 2, b, 64);
    case "torus":
      return new THREE.TorusGeometry(Math.max((a - b) / 2, 1e-4), b / 2, 32, 96);
    case "capsule":
      return new THREE.CapsuleGeometry(a / 2, Math.max(b - a, 0), 16, 32);
    default:
      return new THREE.BoxGeometry(a, b, c);
  }
}

/* ------------------------------------------------------------- the scene */

interface Built {
  key: string;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  objects: Map<string, THREE.Object3D>;
  screens: Map<string, { screen: THREE.MeshBasicMaterial; glare: THREE.MeshStandardMaterial }>;
  lids: Map<string, { pivot: THREE.Object3D; defaultAngle: number }>;
  parents: Map<string, string>;
  lights: Map<string, { light: THREE.Light; spec: Light; target?: THREE.Object3D }>;
  texts: PageText[];
  payload: LoadPayload;
  fontsReady: Promise<void>;
}

let built: Built | null = null;
const loadedFonts = new Set<string>();

async function loadFonts(payload: LoadPayload): Promise<void> {
  await Promise.all(
    payload.fonts.map(async (f) => {
      const key = `${f.family}|${f.url}`;
      if (loadedFonts.has(key)) return;
      const face = new FontFace(f.family, `url(${f.url})`, {
        weight: f.weight ?? "100 900",
        ...(f.unicodeRange ? { unicodeRange: f.unicodeRange } : {}),
      });
      await face.load();
      document.fonts.add(face);
      loadedFonts.add(key);
    }),
  );
}

function disposeBuilt(b: Built): void {
  b.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) m.dispose();
    }
  });
  for (const { light } of b.lights.values()) (light as THREE.DirectionalLight).shadow?.dispose?.();
}

/**
 * Soft shadows: the visible blur width is what matters, not the map resolution. Softer shadows use a
 * smaller shadow map with a proportionally smaller blur radius; the blur (the expensive part on CPU
 * rendering) then costs up to ~16x less for the same look.
 */
function shadowMapFor(softness: number, requested: number): number {
  const ideal = (2048 * 24) / Math.max(1, softness * 12);
  let size = 256;
  while (size < ideal && size < requested) size *= 2;
  return Math.min(requested, size);
}
function softRadius(softness: number, mapSize: number): number {
  return Math.max(1, softness * 12 * (mapSize / 2048));
}

function makeLight(spec: Light): { light: THREE.Light; target?: THREE.Object3D } {
  switch (spec.type) {
    case "ambient":
      return { light: new THREE.AmbientLight(color(spec.color), spec.intensity) };
    case "hemisphere":
      return { light: new THREE.HemisphereLight(color(spec.color), color(spec.groundColor), spec.intensity) };
    case "directional": {
      const l = new THREE.DirectionalLight(color(spec.color), spec.intensity);
      l.castShadow = spec.castShadow;
      const map = shadowMapFor(spec.shadow.softness, spec.shadow.mapSize);
      l.shadow.mapSize.set(map, map);
      l.shadow.bias = spec.shadow.bias;
      l.shadow.normalBias = 0.0004;
      l.shadow.radius = softRadius(spec.shadow.softness, map);
      l.shadow.blurSamples = 16;
      const target = new THREE.Object3D();
      l.target = target;
      return { light: l, target };
    }
    case "point": {
      const l = new THREE.PointLight(color(spec.color), spec.intensity, spec.distance, spec.decay);
      l.castShadow = spec.castShadow;
      const map = shadowMapFor(spec.shadow.softness, spec.shadow.mapSize);
      l.shadow.mapSize.set(map, map);
      l.shadow.bias = spec.shadow.bias;
      l.shadow.radius = softRadius(spec.shadow.softness, map);
      l.shadow.blurSamples = 16;
      l.shadow.camera.near = 0.01;
      return { light: l };
    }
    case "spot": {
      const l = new THREE.SpotLight(color(spec.color), spec.intensity, spec.distance, spec.angle * DEG, spec.penumbra, spec.decay);
      l.castShadow = spec.castShadow;
      const map = shadowMapFor(spec.shadow.softness, spec.shadow.mapSize);
      l.shadow.mapSize.set(map, map);
      l.shadow.bias = spec.shadow.bias;
      l.shadow.normalBias = 0.0004;
      l.shadow.radius = softRadius(spec.shadow.softness, map);
      l.shadow.blurSamples = 16;
      l.shadow.camera.near = 0.05;
      const target = new THREE.Object3D();
      l.target = target;
      return { light: l, target };
    }
  }
}

async function load(payload: LoadPayload): Promise<void> {
  if (built && built.key === payload.key) return;
  if (built) disposeBuilt(built);
  const scene = new THREE.Scene();
  const env = environmentTexture(payload.environment.preset);
  scene.environment = env;
  scene.environmentIntensity = payload.environment.intensity;
  scene.environmentRotation.set(0, payload.environment.rotation * DEG, 0);
  for (const e of payload.effects) {
    if (e.type === "fog") scene.fog = new THREE.Fog(color(e.color), e.near, e.far);
  }

  const camera =
    payload.cameraType === "orthographic"
      ? new THREE.OrthographicCamera(-1, 1, 1, -1, payload.near, payload.far)
      : new THREE.PerspectiveCamera(30, 16 / 9, payload.near, payload.far);

  const objects = new Map<string, THREE.Object3D>();
  const screens = new Map<string, { screen: THREE.MeshBasicMaterial; glare: THREE.MeshStandardMaterial }>();
  const lids = new Map<string, { pivot: THREE.Object3D; defaultAngle: number }>();
  const texts: PageText[] = [];

  for (const n of payload.nodes as PageNode[]) {
    if (n.kind === "text2d") {
      texts.push(n);
      continue;
    }
    let obj: THREE.Object3D;
    if (n.kind === "device") {
      const parts = await buildDevice(n);
      obj = parts.group;
      screens.set(n.id, { screen: parts.screenMaterial, glare: parts.glareMaterial });
      if (parts.lid) lids.set(n.id, { pivot: parts.lid, defaultAngle: parts.defaultLidAngle ?? 110 });
    } else if (n.kind === "plane") {
      const wrap = new THREE.Group();
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(n.size[0], n.size[1]), makeMaterial(n.material));
      mesh.rotation.x = -Math.PI / 2;
      mesh.receiveShadow = n.receiveShadow;
      mesh.castShadow = n.castShadow;
      wrap.add(mesh);
      obj = wrap;
    } else if (n.kind === "primitive") {
      const mesh = new THREE.Mesh(primitiveGeometry(n.shape, n.size, n.cornerRadius), makeMaterial(n.material));
      mesh.castShadow = n.castShadow;
      mesh.receiveShadow = n.receiveShadow;
      obj = mesh;
    } else {
      obj = new THREE.Group();
    }
    obj.name = n.id;
    obj.userData.nodeId = n.id;
    objects.set(n.id, obj);
  }
  for (const n of payload.nodes) {
    if (n.kind === "text2d") continue;
    const obj = objects.get(n.id)!;
    const parent = n.parent ? objects.get(n.parent) : undefined;
    (parent ?? scene).add(obj);
  }

  const lights = new Map<string, { light: THREE.Light; spec: Light; target?: THREE.Object3D }>();
  for (const spec of payload.lights) {
    const { light, target } = makeLight(spec);
    scene.add(light);
    if (target) scene.add(target);
    lights.set(spec.id, { light, spec, ...(target ? { target } : {}) });
  }

  const parents = new Map<string, string>();
  for (const n of payload.nodes) if (n.kind !== "text2d" && n.parent) parents.set(n.id, n.parent);
  built = { key: payload.key, scene, camera, objects, screens, lids, parents, lights, texts, payload, fontsReady: loadFonts(payload) };
  for (const v of videoTextures.values()) {
    v.tex.dispose();
    (v.tex.image as ImageBitmap | undefined)?.close?.();
  }
  videoTextures.clear();
  // Free textures from previous scenes that this scene doesn't use.
  const used = new Set(payload.nodes.flatMap((n) => (n.kind === "device" && n.screenUrl ? [n.screenUrl] : [])));
  for (const [url, tex] of textureCache) {
    if (!used.has(url)) {
      tex.dispose();
      (tex.image as ImageBitmap | undefined)?.close?.();
      textureCache.delete(url);
    }
  }
  await built.fontsReady;
}

/* --------------------------------------------------------------- frames */

function applyNode(obj: THREE.Object3D, f: NodeFrame): void {
  obj.position.set(f.position[0], f.position[1], f.position[2]);
  obj.quaternion.set(f.quaternion[0], f.quaternion[1], f.quaternion[2], f.quaternion[3]);
  obj.scale.set(f.scale[0], f.scale[1], f.scale[2]);
  obj.visible = f.visible;
}

/** Sets material opacity on the meshes a node owns (not on child nodes, which get their own). */
function applyOpacity(obj: THREE.Object3D, op: number): void {
  const visit = (o: THREE.Object3D) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        if (m.userData.isGlare) continue;
        const base = (m.userData.baseOpacity as number | undefined) ?? 1;
        const target = base * op;
        if (m.opacity !== target) {
          m.opacity = target;
          const wantTransparent = target < 1 || m instanceof THREE.ShadowMaterial;
          if (m.transparent !== wantTransparent) {
            m.transparent = wantTransparent;
            m.needsUpdate = true;
          }
        }
      }
    }
    for (const c of o.children) if (!c.userData.nodeId) visit(c);
  };
  visit(obj);
}

function applyLight(entry: { light: THREE.Light; spec: Light; target?: THREE.Object3D }, f: LightFrame): void {
  const l = entry.light;
  l.intensity = f.intensity;
  l.color.copy(color(f.color));
  if (l instanceof THREE.HemisphereLight && f.groundColor) l.groundColor.copy(color(f.groundColor));
  if (f.position) l.position.set(f.position[0], f.position[1], f.position[2]);
  if (entry.target && f.target) entry.target.position.set(f.target[0], f.target[1], f.target[2]);
  if (l instanceof THREE.SpotLight) {
    if (f.angle !== undefined) l.angle = f.angle * DEG;
    if (f.penumbra !== undefined) l.penumbra = f.penumbra;
  }
}

/** Tightly fits directional shadow cameras around shadow casters, for sharp, stable shadows at any scene scale. */
function fitShadows(b: Built): void {
  const box = new THREE.Box3();
  b.scene.updateMatrixWorld(true);
  b.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && mesh.castShadow && mesh.visible) box.expandByObject(mesh);
  });
  if (box.isEmpty()) return;
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const R = Math.max(sphere.radius, 0.01);
  for (const { light, target } of b.lights.values()) {
    if (!(light instanceof THREE.DirectionalLight) || !light.castShadow || !target) continue;
    const dir = new THREE.Vector3().subVectors(light.position, target.position);
    if (dir.lengthSq() < 1e-12) dir.set(0, 1, 0);
    dir.normalize();
    const dist = R * 6 + 1;
    light.position.copy(sphere.center).addScaledVector(dir, dist);
    target.position.copy(sphere.center);
    const cam = light.shadow.camera;
    const extent = R * 2.2;
    cam.left = -extent;
    cam.right = extent;
    cam.top = extent;
    cam.bottom = -extent;
    // Generous depth range: VSM darkens fragments whose light-space depth nears the far plane,
    // which showed up as a faint line where large floors crossed it.
    cam.near = Math.max(0.001, dist - R * 8);
    cam.far = dist + R * 60;
    cam.updateProjectionMatrix();
  }
}

function applyCamera(b: Built, f: FrameState["camera"], aspect: number): void {
  const cam = b.camera;
  cam.position.set(f.position[0], f.position[1], f.position[2]);
  const target = new THREE.Vector3(f.target[0], f.target[1], f.target[2]);
  const forward = new THREE.Vector3().subVectors(target, cam.position).normalize();
  cam.up.set(0, 1, 0);
  if (Math.abs(forward.dot(cam.up)) > 0.999) cam.up.set(0, 0, -1);
  cam.lookAt(target);
  if (f.roll) cam.rotateZ(f.roll * DEG);
  if (cam instanceof THREE.PerspectiveCamera) {
    cam.fov = f.fov;
    cam.aspect = aspect;
  } else {
    const h = f.orthoHeight / 2;
    cam.top = h;
    cam.bottom = -h;
    cam.left = -h * aspect;
    cam.right = h * aspect;
  }
  cam.updateProjectionMatrix();
}

/* ----------------------------------------------------------- 2D layers */

/* Gradients and the vignette are computed per pixel in plain JS with a fixed, position-hashed dither.
 * Canvas gradients are dithered by Skia in a way that differs between the first and later draws,
 * which broke byte-identical output. This is exact, deterministic, and bands less. */

function srgbBytes(hex: string): [number, number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) : 255];
}

/** Deterministic per-pixel dither in [-0.5, 0.5). */
function dither(x: number, y: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 8) / 16777216 - 0.5;
}

const layerCache = new Map<string, HTMLCanvasElement>();
function cachedLayer(key: string, w: number, h: number, fill: (data: Uint8ClampedArray) => void): HTMLCanvasElement {
  const k = `${key}|${w}x${h}`;
  let c = layerCache.get(k);
  if (c) return c;
  c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const cx = c.getContext("2d", { willReadFrequently: true })!;
  const img = cx.createImageData(w, h);
  fill(img.data);
  cx.putImageData(img, 0, 0);
  layerCache.set(k, c);
  if (layerCache.size > 6) layerCache.delete(layerCache.keys().next().value!);
  return c;
}

function gradientLayer(bg: Extract<PageBackground, { type: "gradient" }>, w: number, h: number): HTMLCanvasElement {
  const stops = [...bg.stops].sort((a, b) => a.offset - b.offset).map((s) => ({ o: s.offset, c: srgbBytes(s.color) }));
  return cachedLayer(JSON.stringify(bg), w, h, (data) => {
    let dx = 0, dy = 0, x0 = 0, y0 = 0, inv = 0, cx = 0, cy = 0, r = 1;
    if (bg.kind === "linear") {
      const a = bg.angle * DEG;
      const ux = Math.sin(a), uy = -Math.cos(a);
      const half = (Math.abs(w * ux) + Math.abs(h * uy)) / 2;
      x0 = w / 2 - ux * half;
      y0 = h / 2 - uy * half;
      dx = ux;
      dy = uy;
      inv = 1 / (2 * half || 1);
    } else {
      cx = bg.center[0] * w;
      cy = bg.center[1] * h;
      r = bg.radius * Math.hypot(w, h) || 1;
    }
    const last = stops.length - 1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const px = x + 0.5, py = y + 0.5;
        let t = bg.kind === "linear" ? ((px - x0) * dx + (py - y0) * dy) * inv : Math.hypot(px - cx, py - cy) / r;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        let i = 0;
        while (i < last && t > stops[i + 1]!.o) i++;
        const a = stops[i]!, b = stops[Math.min(i + 1, last)]!;
        const span = b.o - a.o;
        const u = span > 0 ? Math.min(1, Math.max(0, (t - a.o) / span)) : t >= b.o ? 1 : 0;
        const d = dither(x, y);
        const o = (y * w + x) * 4;
        for (let k = 0; k < 4; k++) {
          const v = a.c[k]! + (b.c[k]! - a.c[k]!) * u + (k < 3 ? d : 0);
          data[o + k] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
        }
      }
    }
  });
}

async function drawBackground(bg: PageBackground, w: number, h: number): Promise<void> {
  switch (bg.type) {
    case "transparent":
      return;
    case "solid":
      ctx2d.fillStyle = bg.color;
      ctx2d.fillRect(0, 0, w, h);
      return;
    case "gradient":
      ctx2d.drawImage(gradientLayer(bg, w, h), 0, 0);
      return;
    case "image": {
      const img = await loadBitmap(bg.url);
      ctx2d.drawImage(img, 0, 0, w, h);
      return;
    }
  }
}

function drawVignette(strength: number, hex: string, w: number, h: number): void {
  const [r, g, b] = srgbBytes(hex);
  const layer = cachedLayer(`vignette|${strength}|${hex}`, w, h, (data) => {
    const cx = w / 2, cy = h / 2, diag = Math.hypot(w, h) / 2, inner = diag * 0.35;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const t = Math.min(1, Math.max(0, (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - inner) / (diag - inner)));
        const a = Math.min(1, strength) * t * t * (3 - 2 * t) * 255 + dither(x, y);
        const o = (y * w + x) * 4;
        data[o] = r;
        data[o + 1] = g;
        data[o + 2] = b;
        data[o + 3] = a < 0 ? 0 : a > 255 ? 255 : Math.round(a);
      }
    }
  });
  ctx2d.drawImage(layer, 0, 0);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const grainTile = document.createElement("canvas");
function drawGrain(amount: number, seed: number, frameIndex: number, w: number, h: number, scale: number): void {
  const size = 256;
  grainTile.width = size;
  grainTile.height = size;
  const g = grainTile.getContext("2d")!;
  const img = g.createImageData(size, size);
  const rand = mulberry32((seed * 2654435761 + frameIndex * 97) >>> 0);
  for (let i = 0; i < size * size; i++) {
    const v = Math.round(rand() * 255);
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  ctx2d.save();
  ctx2d.globalCompositeOperation = "overlay";
  ctx2d.globalAlpha = Math.min(1, amount * 2.5);
  const pattern = ctx2d.createPattern(grainTile, "repeat")!;
  pattern.setTransform(new DOMMatrix().scale(Math.max(1, scale)));
  ctx2d.fillStyle = pattern;
  ctx2d.fillRect(0, 0, w, h);
  ctx2d.restore();
}

function wrapLines(text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const words = para.split(/(\s+)/).filter((x) => x.length > 0);
    let line = "";
    for (const word of words) {
      const candidate = line + word;
      if (line && ctx2d.measureText(candidate.trimEnd()).width > maxWidth && word.trim()) {
        out.push(line.trimEnd());
        line = word.trimStart();
      } else line = candidate;
    }
    out.push(line.trimEnd());
  }
  return out;
}

function drawText(t: PageText, f: NodeFrame, w: number, h: number, scale: number): void {
  if (!f.visible || f.opacity <= 0) return;
  const size = (f.size ?? 64) * scale;
  ctx2d.save();
  ctx2d.globalAlpha = f.opacity;
  ctx2d.font = `${t.weight} ${size}px "${t.font}", "Inter", system-ui, sans-serif`;
  (ctx2d as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${t.letterSpacing * size}px`;
  ctx2d.fillStyle = f.color ?? "#111111";
  ctx2d.textAlign = t.align;
  ctx2d.textBaseline = "middle";
  const lines = wrapLines(t.content, t.maxWidth * w);
  const lh = t.lineHeight * size;
  const anchor = f.anchor ?? [0.5, 0.1];
  ctx2d.translate(anchor[0] * w, anchor[1] * h);
  if (f.rotation) ctx2d.rotate(f.rotation * DEG);
  const top = -((lines.length - 1) * lh) / 2;
  lines.forEach((line, i) => ctx2d.fillText(line, 0, top + i * lh));
  ctx2d.restore();
}

/* ---------------------------------------------------------------- render */

async function render(frame: FrameState, opts: RenderFrameOptions): Promise<string> {
  if (!built) throw new Error("render() before load()");
  const T: Array<[string, number]> = [["start", performance.now()]];
  const mark = (n: string) => T.push([n, performance.now()]);
  const b = built;
  const { width: w, height: h } = opts;
  if (glCanvas.width !== w || glCanvas.height !== h) renderer.setSize(w, h, false);
  for (const [id, obj] of b.objects) {
    const f = frame.nodes[id];
    if (f) applyNode(obj, f);
  }
  // Opacity multiplies down the hierarchy: a fading group fades its children.
  const effective = new Map<string, number>();
  const opacityOf = (id: string): number => {
    const hit = effective.get(id);
    if (hit !== undefined) return hit;
    const own = frame.nodes[id]?.opacity ?? 1;
    const parent = b.parents.get(id);
    const v = own * (parent ? opacityOf(parent) : 1);
    effective.set(id, v);
    return v;
  };
  for (const [id, obj] of b.objects) applyOpacity(obj, opacityOf(id));
  for (const [id, mats] of b.screens) mats.glare.userData.nodeOpacity = opacityOf(id);
  for (const [id, url] of Object.entries(opts.screenFrames ?? {})) {
    const mats = b.screens.get(id);
    if (!mats) continue;
    const cur = videoTextures.get(id);
    if (cur?.url === url) continue;
    const tex = await loadFrameTexture(url);
    mats.screen.map = tex;
    mats.screen.userData.baseColor = new THREE.Color(0xffffff);
    mats.screen.needsUpdate = !cur;
    if (cur) {
      cur.tex.dispose();
      (cur.tex.image as ImageBitmap | undefined)?.close?.();
    }
    videoTextures.set(id, { url, tex });
  }
  for (const [id, mats] of b.screens) {
    const f = frame.nodes[id];
    if (!f) continue;
    const base = mats.screen.userData.baseColor as THREE.Color;
    mats.screen.color.copy(base).multiplyScalar(f.screenBrightness ?? 1);
    mats.glare.opacity = (f.screenGlare ?? 0.25) * ((mats.glare.userData.nodeOpacity as number | undefined) ?? f.opacity);
    mats.glare.visible = (f.screenGlare ?? 0.25) > 0;
  }
  for (const [id, lid] of b.lids) {
    const angle = frame.nodes[id]?.lidAngle ?? lid.defaultAngle;
    lid.pivot.rotation.x = (90 - angle) * DEG;
  }
  for (const [id, entry] of b.lights) {
    const f = frame.lights[id];
    if (f) applyLight(entry, f);
  }
  mark("apply");
  fitShadows(b);
  mark("fitShadows");
  applyCamera(b, frame.camera, w / h);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.render(b.scene, b.camera);
  mark("webgl");

  composite.width = w;
  composite.height = h;
  ctx2d.clearRect(0, 0, w, h);
  if (!opts.transparent && opts.background) await drawBackground(opts.background, w, h);
  mark("bg");
  ctx2d.drawImage(glCanvas, 0, 0);
  mark("drawGL");
  for (const e of b.payload.effects) {
    if (e.type === "vignette" && !opts.transparent) drawVignette(e.strength, e.color, w, h);
    if (e.type === "grain") drawGrain(e.amount, b.payload.seed, opts.frameIndex, w, h, opts.scale);
  }
  if (b.texts.length) {
    await b.fontsReady;
    for (const t of b.texts) {
      const f = frame.nodes[t.id];
      if (f) drawText(t, f, w, h, opts.scale);
    }
  }
  if (opts.output === "rgba") {
    const ow = opts.outWidth ?? w, oh = opts.outHeight ?? h;
    let src: HTMLCanvasElement = composite;
    if (ow !== w || oh !== h) {
      outCanvas.width = ow;
      outCanvas.height = oh;
      const octx = outCanvas.getContext("2d", { alpha: true, willReadFrequently: true })!;
      octx.clearRect(0, 0, ow, oh);
      octx.imageSmoothingEnabled = true;
      octx.imageSmoothingQuality = "high";
      octx.drawImage(composite, 0, 0, ow, oh);
      src = outCanvas;
    }
    mark("downscale");
    const data = src.getContext("2d")!.getImageData(0, 0, ow, oh, { colorSpace: "srgb" }).data;
    mark("readback");
    // Fire and forget: Node waits for the upload itself, so the next frame can start drawing now.
    void fetch(opts.uploadUrl!, { method: "POST", body: data, headers: { "content-type": "application/octet-stream" } }).catch((e: Error) =>
      console.error(`Frame upload failed: ${e.message}`),
    );
    mark("upload");
    if (DEBUG_TIMING) console.debug("timing " + T.slice(1).map(([n, t], i) => `${n}=${Math.round(t - T[i]![1])}`).join(" "));
    return "";
  }
  const url = composite.toDataURL("image/png");
  return url.slice(url.indexOf(",") + 1);
}

const outCanvas = document.createElement("canvas");

function limits(): PageLimits {
  const gl = renderer.getContext();
  const vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  return {
    maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
    maxViewport: [vp[0]!, vp[1]!],
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    renderer: dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER)),
  };
}

const api: PageApi = { limits, load, render };
(window as unknown as { dw: PageApi }).dw = api;
(window as unknown as { dwReady: boolean }).dwReady = true;
