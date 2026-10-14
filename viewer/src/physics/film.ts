import * as THREE from "three";
import type { ComponentModel } from "../model";
import type { SectionTool } from "../section";
import type { Vec3 } from "../types";
import type { Viewer } from "../viewer";
import { injectPhysics, makeUniforms, ROLE, type PhysicsUniforms } from "./shading";
import { FILM, INSUL, percentile, solveLadder, streamlines, type Grid, type Solution, type Streamline } from "./solver";

const LINES = 48;               // streamlines (equal current between neighbours)
const PARTICLES_PER_LINE = 12;

/** Metadata shared by every resistive-film physics type (chip resistor, carbon film ...). */
export interface FilmMeta {
  type: string;
  film_layer: string;
  domain: [[number, number], [number, number]];
  contact_x: [number, number];
  contacts: { positive: string[]; negative: string[] };
  thermal_layers: string[];
  fade_layers: string[];
  hide_layers?: string[];
  electrical: { nominal_ohm: number; rated_power_w: number; max_working_voltage_v: number };
  camera: { direction: Vec3 };
}

export interface FilmState {
  on: boolean;
  voltage: number;              // V
  potential: boolean;
  lines: boolean;
  current: boolean;
  heat: boolean;
  electrons: boolean;           // show electron drift (opposite to conventional current)
}

export interface FilmReadout {
  V: number; I: number; P: number; R: number; rated: number;
  stage: string | null;
}

/** One step of the staged "power on" sequence (seconds). */
export interface Stage { key: "volt" | "field" | "flow" | "heat" | "spread"; start: number; end: number; caption: string }

/**
 * Sheet conduction in a thin resistive film: the film field is solved (Laplace on the
 * film, `solver.ts`); the spread of heat into the body and terminals is an illustrative
 * animation, and is labelled as such. Subclasses give the film its shape (flat or on a
 * cylinder), the cut that sets the resistance, and the sheet resistance.
 */
export abstract class FilmPhysics<M extends FilmMeta, S extends FilmState> {
  readonly U: PhysicsUniforms = makeUniforms();
  abstract readonly state: S;
  meta: M | null = null;
  onChange: () => void = () => {};

  protected abstract readonly type: string;
  protected abstract readonly stages: readonly Stage[];
  /** Film-plane mapping for the shaders: flat (x, y) or unrolled cylinder. */
  protected mapping: "xy" | "xz" | "cyl" = "xy";
  protected nx = 220;           // grid cells along the film length
  /** Grid used while a slider is dragged (null: always full resolution). */
  protected dragNx: number | null = null;

  protected viewer: Viewer;
  protected section: SectionTool;
  protected model: ComponentModel | null = null;
  protected grid: Grid | null = null;
  protected sol: Solution | null = null;
  protected lines: Streamline[] = [];
  protected tex: THREE.DataTexture | null = null;
  protected skin: THREE.Mesh | null = null;
  protected points: THREE.Points | null = null;
  private particles: { line: number; s: number }[] = [];
  private faded = new Map<string, { opacity: number; transparent: boolean; depthWrite: boolean }>();
  protected seq: { t: number } | null = null;
  private solveQueued: number | null = null;
  private refine: number | null = null;
  private iRef = 1;
  protected qRef = 0;           // heat reference: 99th-percentile |J|^2 of the reference geometry
                                // (0: taken from the first solution after attach)
  protected vRef = 1;           // default voltage (50 % of rated power at the nominal value)

  constructor(viewer: Viewer, section: SectionTool) {
    this.viewer = viewer;
    this.section = section;
    viewer.onFrame((dt) => this.tick(dt));
    section.onChange(() => this.syncClipping());
  }

  get available(): boolean {
    return !!this.meta;
  }

  // ------------------------------------------------------------------ subclass hooks
  /** Rasteriser of the film (contacts + cut) for the current state, at any resolution. */
  protected abstract builder(): (nx: number) => Grid;
  /** Sheet resistance (ohm per square) for the current state. */
  protected abstract sheetOhm(): number;
  /** Set shader uniforms that place the film (after the domain uniforms). */
  protected abstract setupMapping(m: M): void;
  /** Called once per attach before the first solve (calibration, references). */
  protected abstract calibrate(m: M): void;
  /** Mesh drawing the film's physics colours on its surface (un-cut; the cut is the mask). */
  protected abstract buildSkin(m: M, model: ComponentModel): THREE.Mesh;
  /** 3D (CAD) position of a film point, slightly above the surface. */
  protected abstract particlePos(x: number, y: number, out: THREE.Vector3): void;
  /** Heat display gain relative to the reference (1 when the sheet resistance is fixed). */
  protected heatScale(): number {
    return 1;
  }

  /** Bind to a loaded model; returns false if it has no physics of this type. */
  attach(model: ComponentModel): boolean {
    this.detachObjects();
    this.model = model;
    const meta = model.meta.physics as FilmMeta | undefined;
    this.meta = meta?.type === this.type ? (meta as M) : null;
    if (!this.meta) return false;
    const m = this.meta;
    const [[x0, y0], [x1, y1]] = m.domain;
    const U = this.U;
    U.uDomainMin.value.set(x0, y0);
    U.uDomainSize.value.set(x1 - x0, y1 - y0);
    model.group.updateMatrixWorld(true);
    U.uWorldToCad.value.copy(model.root.matrixWorld).invert();
    this.setupMapping(m);
    this.calibrate(m);
    this.vRef = +Math.sqrt(0.5 * m.electrical.rated_power_w * m.electrical.nominal_ohm).toFixed(1);
    if (!this.state.voltage) this.state.voltage = this.vRef;

    // materials: film, contacts, body (surfaces and section caps)
    const role = (id: string) =>
      id === m.film_layer ? ROLE.FILM
        : m.contacts.positive.includes(id) ? ROLE.POSITIVE
          : m.contacts.negative.includes(id) ? ROLE.NEGATIVE
            : m.thermal_layers.includes(id) ? ROLE.BODY : 0;
    for (const l of model.layers) {
      const r = role(l.meta.id);
      if (!r) continue;
      injectPhysics(l.material, r, U, this.mapping);
      const cap = this.section.capMaterial(l.meta.id);
      if (cap) injectPhysics(cap, r, U, this.mapping);
    }
    this.skin = this.buildSkin(m, model);
    this.skin.name = "physics-film-skin";
    this.skin.renderOrder = 10_001;
    this.skin.raycast = () => {};
    model.root.add(this.skin);
    this.buildPoints();
    this.solveNow(this.nx, false);
    this.applyState();
    return true;
  }

  /** Material for the film skin (film colour, physics shading on top). */
  protected skinMaterial(model: ComponentModel): THREE.MeshStandardMaterial {
    const film = model.byId.get(this.meta!.film_layer)!.meta;
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(film.color), roughness: 0.6, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
    });
    injectPhysics(mat, ROLE.FILM, this.U, this.mapping);
    return mat;
  }

  // ------------------------------------------------------------------ public controls
  setOn(on: boolean): void {
    this.state.on = on;
    if (!on) this.seq = null;
    this.applyState();
  }

  /** Run the staged power-on sequence (~8 s). */
  play(instant = false): void {
    if (!this.meta) return;
    this.state.on = true;
    this.state.potential = true;
    this.state.lines = true;
    this.state.current = true;
    this.state.heat = true;
    this.seq = instant ? null : { t: 0 };
    this.applyState();
  }

  set<K extends keyof S>(key: K, value: S[K]): void {
    this.state[key] = value;
    this.applyState();
  }

  readout(): FilmReadout | null {
    const m = this.meta;
    if (!m || !this.sol) return null;
    const R = this.sheetOhm() * this.sol.r;
    const V = this.state.voltage;
    const I = V / R;
    const stage = this.seq ? this.stages.find((s) => this.seq!.t < s.end)?.caption ?? null : null;
    return { V, I, P: V * I, R, rated: m.electrical.rated_power_w, stage };
  }

  // ------------------------------------------------------------------ solving
  /** Geometry changed: solve now (coarse while dragging, then refined once idle). */
  protected queueSolve(): void {
    if (this.solveQueued !== null) return;
    this.solveQueued = requestAnimationFrame(() => {
      this.solveQueued = null;
      this.solveNow(this.dragNx ?? this.nx, true);
      this.onChange();
      if (this.dragNx === null) return;
      if (this.refine !== null) clearTimeout(this.refine);
      this.refine = window.setTimeout(() => {
        this.refine = null;
        this.solveNow(this.nx, true);
        this.onChange();
      }, 250);
    });
  }

  protected solveNow(nx: number, warm: boolean): void {
    if (!this.meta) return;
    const prev = warm && this.sol && this.grid?.nx === nx ? this.sol.V : undefined;
    const { grid, sol } = this.solveField(nx, prev);
    this.grid = grid;
    this.sol = sol;
    this.lines = streamlines(grid, sol, LINES);
    if (!this.qRef) this.qRef = percentile(grid, sol.q, 0.99) || 1;
    this.writeTexture();
    this.resetParticles();
    this.updatePower();
    this.viewer.invalidate();
  }

  /** Solve the current state (subclasses with extra conditions, e.g. a loaded tap, override). */
  protected solveField(nx: number, warm?: Float32Array): { grid: Grid; sol: Solution } {
    return solveLadder(this.builder(), nx, warm);
  }

  /** The 99th-percentile |J|^2 of a solution: the heat colour scale's reference. */
  protected heatReference(build: (nx: number) => Grid): number {
    const ref = solveLadder(build, this.nx);
    return percentile(ref.grid, ref.sol.q, 0.99) || 1;
  }

  private writeTexture(): void {
    const g = this.grid!, s = this.sol!;
    const n = g.nx * g.ny;
    // heat relative to a fixed reference, so geometries compare honestly;
    // the voltage enters as V^2 through uHeatGain
    const heat = new Float32Array(n);
    for (let k = 0; k < n; k++) heat[k] = g.type[k] === FILM ? s.q[k] / this.qRef : 0;
    const blur = boxBlur(heat, g.nx, g.ny, Math.max(2, Math.round(Math.min(g.ny, 2 * g.nx) * 0.12)), 3, !!g.periodicY);
    let bmax = 0;
    for (let k = 0; k < n; k++) bmax = Math.max(bmax, blur[k]);
    const data = new Uint16Array(n * 4);
    const h = THREE.DataUtils.toHalfFloat;
    for (let k = 0; k < n; k++) {
      data[4 * k] = h(s.V[k]);
      data[4 * k + 1] = h(Math.min(heat[k], 4));
      data[4 * k + 2] = h(bmax ? blur[k] / bmax : 0);
      data[4 * k + 3] = h(g.type[k] === INSUL ? 0 : 1);
    }
    if (this.tex && (this.tex.image.width !== g.nx || this.tex.image.height !== g.ny)) {
      this.tex.dispose();
      this.tex = null;
    }
    if (!this.tex) {
      this.tex = new THREE.DataTexture(data, g.nx, g.ny, THREE.RGBAFormat, THREE.HalfFloatType);
      this.tex.magFilter = this.tex.minFilter = THREE.LinearFilter;
      this.tex.wrapS = THREE.ClampToEdgeWrapping;
      // a film around a cylinder wraps: filtering across the seam must too
      this.tex.wrapT = g.periodicY ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    } else {
      (this.tex.image as { data: Uint16Array }).data = data;
    }
    this.tex.needsUpdate = true;
    this.U.uFieldTex.value = this.tex;
    // reference current for particle speed: median |J| over the film
    const sp: number[] = [];
    for (const l of this.lines) for (const v of l.speed) sp.push(v);
    sp.sort((a, b) => a - b);
    this.iRef = sp[Math.floor(sp.length / 2)] || 1;
  }

  // ------------------------------------------------------------------ scene objects
  private buildPoints(): void {
    const n = LINES * PARTICLES_PER_LINE;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    const mat = new THREE.PointsMaterial({
      size: 5, sizeAttenuation: false, map: dotTexture(), transparent: true, depthWrite: false,
      color: 0xfff1b8, alphaTest: 0.05,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.name = "physics-current";
    this.points.renderOrder = 10_002;
    this.points.frustumCulled = false;
    this.points.raycast = () => {};
    this.model!.root.add(this.points);
  }

  private resetParticles(): void {
    this.particles = [];
    this.lines.forEach((l, i) => {
      const L = l.len[l.len.length - 1];
      for (let p = 0; p < PARTICLES_PER_LINE; p++)
        this.particles.push({ line: i, s: ((p + ((i * 0.618) % 1)) / PARTICLES_PER_LINE) * L });
    });
  }

  private detachObjects(): void {
    this.restoreFaded();
    for (const o of [this.skin, this.points]) {
      if (!o) continue;
      o.removeFromParent();
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
    if (this.refine !== null) clearTimeout(this.refine);
    this.refine = null;
    this.skin = this.points = null;
    this.seq = null;
    this.meta = null;
    this.sol = null;
    this.grid = null;
  }

  // ------------------------------------------------------------------ state -> uniforms
  protected applyState(): void {
    const m = this.meta;
    if (!m || !this.model) return;
    const s = this.state, U = this.U;
    U.uOn.value = s.on ? 1 : 0;
    if (!this.seq) {
      U.uVolt.value = 1;
      U.uField.value = 1;
      U.uHeatMix.value = s.heat ? 1 : 0;
      U.uSpread.value = s.heat ? 1 : 0;
    }
    U.uShowPot.value = s.potential ? 1 : 0;
    U.uShowLines.value = s.lines ? 1 : 0;
    this.updatePower();
    if (this.skin) this.skin.visible = s.on;
    if (this.points) {
      this.points.visible = s.on && s.current;
      (this.points.material as THREE.PointsMaterial).color.set(s.electrons ? 0x7fdcff : 0xfff1b8);
    }
    if (s.on) this.fade(); else this.restoreFaded();
    this.syncClipping();
    this.viewer.invalidate();
    this.onChange();
  }

  private updatePower(): void {
    const r = this.readout();
    if (!r) return;
    const frac = r.P / r.rated;
    // power density = V^2 * q / R_sheet: at the default voltage the reference geometry's
    // high-current cells sit at ~0.62 of the ramp and its hot spots saturate
    this.U.uHeatGain.value = 0.62 * (r.V / this.vRef) ** 2 * this.heatScale();
    this.U.uTermHeat.value = 0.55 * Math.min(1, 0.25 + 1.3 * frac);
    this.U.uHeatEmit.value = 0.55 + 2.5 * Math.max(0, frac - 1);
  }

  private fade(): void {
    for (const id of this.meta!.hide_layers ?? []) {
      const l = this.model!.byId.get(id);
      if (l) l.mesh.visible = false;
    }
    for (const id of this.meta!.fade_layers) {
      const l = this.model!.byId.get(id);
      if (!l || this.faded.has(id)) continue;
      const mat = l.material;
      this.faded.set(id, { opacity: mat.opacity, transparent: mat.transparent, depthWrite: mat.depthWrite });
      mat.transparent = true;
      mat.opacity = 0.08;
      mat.depthWrite = false;
      mat.needsUpdate = true;
    }
  }

  private restoreFaded(): void {
    for (const id of this.meta?.hide_layers ?? []) {
      const l = this.model?.byId.get(id);
      if (l) l.mesh.visible = l.visible;
    }
    for (const [id, st] of this.faded) {
      const l = this.model?.byId.get(id);
      if (!l) continue;
      Object.assign(l.material, st);
      l.material.needsUpdate = true;
    }
    this.faded.clear();
  }

  private syncClipping(): void {
    const planes = this.section.enabled ? [this.section.plane] : [];
    for (const o of [this.skin, this.points]) {
      if (!o) continue;
      const mat = o.material as THREE.Material;
      if (mat.clippingPlanes?.length !== planes.length) {
        mat.clippingPlanes = planes;
        mat.needsUpdate = true;
      }
    }
  }

  // ------------------------------------------------------------------ animation
  private tick(dt: number): boolean {
    if (!this.meta || !this.state.on) return false;
    const U = this.U;
    let animating = false;
    if (this.seq) {
      this.seq.t += dt;
      const t = this.seq.t;
      const p = (key: Stage["key"]) => {
        const st = this.stages.find((s) => s.key === key)!;
        return smooth((t - st.start) / (st.end - st.start));
      };
      U.uVolt.value = p("volt");
      U.uField.value = p("field");
      U.uHeatMix.value = p("heat");
      U.uSpread.value = p("spread");
      if (t > this.stages[this.stages.length - 1].end + 0.3) this.seq = null;
      this.onChange();
      animating = true;
    }
    if (this.points?.visible) {
      this.advanceParticles(dt);
      animating = true;
    }
    return animating;
  }

  private tmp = new THREE.Vector3();

  private advanceParticles(dt: number): void {
    const flowStart = this.stages.find((s) => s.key === "flow")!.start;
    const flowIn = this.seq ? smooth((this.seq.t - flowStart) / 1.0) : 1;
    const mat = this.points!.material as THREE.PointsMaterial;
    mat.opacity = flowIn;
    const r = this.readout()!;
    const iNominal = Math.sqrt(0.5 * r.rated / this.meta!.electrical.nominal_ohm);
    const gain = THREE.MathUtils.clamp(r.I / iNominal, 0.1, 3);
    const base = 0.35 * gain;                    // mm/s at median current density
    const dir = this.state.electrons ? -1 : 1;
    const pos = this.points!.geometry.getAttribute("position") as THREE.BufferAttribute;
    let i = 0;
    for (const p of this.particles) {
      const l = this.lines[p.line];
      const L = l.len[l.len.length - 1];
      const k = locate(l.len, p.s);
      const sp = l.speed[k] / this.iRef;
      p.s += dir * base * Math.min(sp, 6) * dt * (this.seq ? flowIn : 1);
      if (p.s > L) p.s -= L;
      if (p.s < 0) p.s += L;
      const kk = locate(l.len, p.s);
      const u = kk < l.len.length - 1 ? (p.s - l.len[kk]) / (l.len[kk + 1] - l.len[kk] || 1) : 0;
      const x = l.pts[2 * kk] + u * ((l.pts[2 * kk + 2] ?? l.pts[2 * kk]) - l.pts[2 * kk]);
      const y = l.pts[2 * kk + 1] + u * ((l.pts[2 * kk + 3] ?? l.pts[2 * kk + 1]) - l.pts[2 * kk + 1]);
      this.particlePos(x, y, this.tmp);
      pos.setXYZ(i++, this.tmp.x, this.tmp.y, this.tmp.z);
    }
    for (; i < pos.count; i++) pos.setXYZ(i, 0, 0, -10);
    pos.needsUpdate = true;
  }

  /** For tests: current conservation of the current solution and its streamline count. */
  conservation() {
    const s = this.sol!;
    return { iIn: s.iIn, iOut: s.iOut, lines: this.lines.length, r: s.r };
  }
}

function smooth(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

function locate(arr: Float32Array, v: number): number {
  let lo = 0, hi = arr.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= v) lo = mid; else hi = mid;
  }
  return lo;
}

function boxBlur(src: Float32Array, nx: number, ny: number, r: number, passes: number, wrapY: boolean): Float32Array {
  let a = Float32Array.from(src), b = new Float32Array(src.length);
  for (let p = 0; p < passes; p++) {
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      let s = 0, c = 0;
      for (let d = -r; d <= r; d++) { const ii = i + d; if (ii >= 0 && ii < nx) { s += a[j * nx + ii]; c++; } }
      b[j * nx + i] = s / c;
    }
    [a, b] = [b, a];
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      let s = 0, c = 0;
      for (let d = -r; d <= r; d++) {
        let jj = j + d;
        if (wrapY) jj = ((jj % ny) + ny) % ny;
        if (jj >= 0 && jj < ny) { s += a[jj * nx + i]; c++; }
      }
      b[j * nx + i] = s / c;
    }
    [a, b] = [b, a];
  }
  return a;
}

let dot: THREE.Texture | null = null;
function dotTexture(): THREE.Texture {
  if (dot) return dot;
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.45, "rgba(255,255,255,0.9)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  dot = new THREE.CanvasTexture(c);
  return dot;
}
