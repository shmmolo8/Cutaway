import * as THREE from "three";
import type { ComponentModel } from "../model";
import type { SectionTool } from "../section";
import type { CoilPhysicsMeta } from "../types";
import type { Viewer } from "../viewer";
import { injectPhysics, makeUniforms, ROLE, type PhysicsUniforms } from "./shading";
import { contours, makeGrid, sample, solvePoissonLadder, type Grid, type PoissonProblem } from "./solver";

const NX = 240;
/** Poisson problem plus the material reluctivity and ferrite mask (nu is nu/r when axisymmetric). */
type Problem = PoissonProblem & { nuMat: Float32Array; fe: Uint8Array };
const MU0 = 4e-7 * Math.PI;
const Y_OVERLAY = -0.0015;
const TAU = 0.8;                 // L/R time constant shown in the energize sequence (animation s)
const AC_VIS_HZ = 0.35;

const STAGES = [
  { key: "on", start: 0.0, end: 1.0, caption: "1 · Switched on: the coil's own back-EMF opposes the change, so the current starts from zero" },
  { key: "build", start: 1.0, end: 3.2, caption: "2 · Current and field build together; the changing flux induces −∂A/∂t that limits the rise (τ = L/R)" },
  { key: "core", start: 3.2, end: 5.4, caption: "3 · The ferrite concentrates the flux: compared with an air core, B inside is far stronger for the same current" },
  { key: "steady", start: 5.4, end: 7.4, caption: "4 · Steady DC: no induced voltage; energy ½LI² sits in the field and only R_dc drops voltage" },
] as const;

export interface CoilState {
  on: boolean;
  current: number;         // DC current (A)
  field: boolean;          // |B| palette on the ferrite
  fieldLines: boolean;
  flow: boolean;           // markers moving along the field lines
  coilCurrent: boolean;    // markers moving along the conductor
  induced: boolean;        // induced E = -dA/dt (red/blue)
  core: boolean;           // ferrite visible (off: see the coil)
  shield: boolean;         // shield ferrite (metadata group "shield") present in the solve
  ac: boolean;
  acAmp: number;           // AC current amplitude (A)
  freqLog: number;
  paused: boolean;
  phaseDeg: number;
}

/**
 * 2D magnetostatics of a multilayer chip inductor in the section through its axis
 * (metadata `physics.type = "coil_magnetics"`): div(nu grad A) = -J with nu = 1/mu_r,
 * solved for 1 A with the ferrite and again with an air core. B, field lines (contours
 * of A), energy and an inductance estimate follow; everything scales linearly with I.
 */
export class CoilPhysics {
  readonly U: PhysicsUniforms = makeUniforms();
  readonly state: CoilState = {
    on: false, current: 0, field: true, fieldLines: true, flow: true, coilCurrent: true, induced: false, core: true,
    shield: true, ac: false, acAmp: 0.05, freqLog: 6, paused: false, phaseDeg: 0,
  };
  meta: CoilPhysicsMeta | null = null;
  onChange: () => void = () => {};

  private viewer: Viewer;
  private section: SectionTool;
  private model: ComponentModel | null = null;
  private fer: (Problem & { A: Float32Array }) | null = null;
  private air: (Problem & { A: Float32Array }) | null = null;
  private tex: THREE.DataTexture | null = null;
  private overlay = new THREE.Group();
  private lines: THREE.LineSegments | null = null;
  private flux: { pts: Float32Array; len: Float32Array; speed: Float32Array }[] = [];
  private fluxDots: THREE.Points | null = null;
  private fluxS: { line: number; s: number }[] = [];
  private coilDots: THREE.Points | null = null;
  private coilLen: Float32Array = new Float32Array();
  private coilPts: Float32Array = new Float32Array();
  private coilS: number[] = [];
  private cutDots: THREE.Points[] = [];
  private seq: { t: number } | null = null;
  private theta = 0;
  private bRef = 1;
  private derived = { L2d: 0, bWindow: 0, bWindowAir: 0, bAbove: 0, ampereLoop: 0, ampereEnclosed: 0 };

  constructor(viewer: Viewer, section: SectionTool) {
    this.viewer = viewer;
    this.section = section;
    this.overlay.name = "coil-physics";
    viewer.onFrame((dt) => this.tick(dt));
    section.onChange(() => this.syncClipping());
  }

  get available(): boolean {
    return !!this.meta;
  }

  attach(model: ComponentModel): boolean {
    this.detach();
    this.model = model;
    const meta = model.meta.physics;
    this.meta = meta?.type === "coil_magnetics" ? meta : null;
    if (!this.meta) return false;
    const m = this.meta, U = this.U;
    model.group.updateMatrixWorld(true);
    U.uWorldToCad.value.copy(model.root.matrixWorld).invert();
    U.uPalette.value = 2;
    U.uShowLines.value = 0;
    U.uHeatEmit.value = 0.2;
    if (!this.state.current) this.state.current = m.electrical.rated_current_a / 2;

    for (const l of model.layers) {
      const id = l.meta.id;
      const role = (m.core_layers ?? [m.core_layer]).includes(id) ? ROLE.FILM
        : m.contacts.positive.includes(id) ? ROLE.POSITIVE
          : m.contacts.negative.includes(id) ? ROLE.NEGATIVE : 0;
      if (!role) continue;
      injectPhysics(l.material, role, U, "xz");
      const cap = this.section.capMaterial(id);
      if (cap) injectPhysics(cap, role, U, "xz");
    }

    this.fer = solvePoissonLadder((nx) => this.problem(nx, true), this.meta!.grid_nx ?? NX, !!this.meta!.axisym);
    this.air = solvePoissonLadder((nx) => this.problem(nx, false), this.meta!.grid_nx ?? NX, !!this.meta!.axisym);
    const g = this.fer.grid;
    U.uDomainMin.value.set(g.x0, g.y0);
    U.uDomainSize.value.set(g.nx * g.dx, g.ny * g.dy);
    this.computeDerived();
    this.writeTexture();
    this.buildFieldLines();
    this.buildCutGlyphs();
    this.buildCoilDots();
    model.root.add(this.overlay);
    this.syncClipping();
    this.applyState();
    return true;
  }

  // ------------------------------------------------------------------ solve
  /**
   * 1 A through the coil; nu = 1/mu_r in the ferrite (or 1 everywhere for the air core).
   * Planar: A is the out-of-plane vector potential. Axisymmetric (`axisym`): A is the flux
   * function psi = r·A_phi, the coefficient is nu/r, psi = 0 on the axis (a grid row) and the
   * winding's current is the same sign on both sides of the axis.
   */
  private problem(nx: number, ferrite: boolean): Problem {
    const m = this.meta!;
    const [[x0, z0], [x1, z1]] = m.domain;
    const ax = m.axisym;
    let grid: Grid;
    if (ax) {                                  // odd row count with the axis on the centre row
      const half = Math.max(ax.axis_z - z0, z1 - ax.axis_z), dx = (x1 - x0) / nx;
      const rows = 2 * Math.round(half / dx) + 1, dy = (2 * half) / rows;
      grid = makeGrid(x0, ax.axis_z - half, x1, ax.axis_z + half, nx, dy);
    } else grid = makeGrid(x0, z0, x1, z1, nx);
    const n = grid.nx * grid.ny;
    const nu = new Float32Array(n).fill(1), src = new Float32Array(n), fe = new Uint8Array(n);
    const cx = (i: number) => grid.x0 + (i + 0.5) * grid.dx, cz = (j: number) => grid.y0 + (j + 0.5) * grid.dy;
    const rects = m.ferrite
      ? m.ferrite.filter((f) => f.group !== "shield" || this.state.shield).map((f) => f.rect)
      : [m.body];
    if (ferrite) for (let j = 0; j < grid.ny; j++) for (let i = 0; i < grid.nx; i++) {
      const x = cx(i), z = cz(j);
      if (rects.some(([[a, b], [c, d]]) => x > a && x < c && z > b && z < d)) {
        nu[j * grid.nx + i] = 1 / m.electrical.mu_r;
        fe[j * grid.nx + i] = 1;
      }
    }
    const area = grid.dx * grid.dy;
    for (const c of m.cuts) {
      const cells: number[] = [];
      for (let j = 0; j < grid.ny; j++) for (let i = 0; i < grid.nx; i++) {
        const x = cx(i), z = cz(j);
        if (x >= c.x[0] && x <= c.x[1] && z >= c.z[0] && z <= c.z[1]) cells.push(j * grid.nx + i);
      }
      if (!cells.length) {                                   // thinner than a cell: nearest cell
        const i = Math.floor(((c.x[0] + c.x[1]) / 2 - grid.x0) / grid.dx), j = Math.floor(((c.z[0] + c.z[1]) / 2 - grid.y0) / grid.dy);
        cells.push(j * grid.nx + i);
      }
      // exactly `amps` (default 1) per cut; axisymmetric: J_phi has the same sign on both sides
      const I = (ax ? 1 : c.dir) * (c.amps ?? 1);
      for (const k of cells) { src[k] += I / (cells.length * area); nu[k] = 1; fe[k] = 0; }
    }
    const nuMat = Float32Array.from(nu);
    let zero: Uint8Array | undefined;
    if (ax) {
      zero = new Uint8Array(n);
      const jc = (grid.ny - 1) / 2;
      for (let j = 0; j < grid.ny; j++) {
        const r = Math.max(Math.abs(cz(j) - ax.axis_z), grid.dy / 2);
        for (let i = 0; i < grid.nx; i++) {
          nu[j * grid.nx + i] /= r;
          if (j === jc) zero[j * grid.nx + i] = 1;
        }
      }
    }
    return { grid, nu, src, zero, nuMat, fe };
  }

  /** |B| (tesla per ampere) at cell k from A (A per 1 A of coil current). */
  private bAt(p: Problem & { A: Float32Array }, k: number): number {
    const { grid: g, A } = p, nx = g.nx, i = k % nx, j = Math.floor(k / nx);
    if (i < 1 || j < 1 || i >= nx - 1 || j >= g.ny - 1) return 0;
    const dAdx = (A[k + 1] - A[k - 1]) / (2 * g.dx), dAdz = (A[k + nx] - A[k - nx]) / (2 * g.dy);
    const ax = this.meta!.axisym;
    if (!ax) return MU0 * 1e3 * Math.hypot(dAdx, dAdz);
    // B = |grad psi| / r; on the axis psi ~ c r^2, so B = 2 psi(dy) / dy^2
    const r = Math.abs(g.y0 + (j + 0.5) * g.dy - ax.axis_z);
    if (r < g.dy / 2) return MU0 * 1e3 * Math.abs(A[k + nx] + A[k - nx]) / (g.dy * g.dy);
    return (MU0 * 1e3 * Math.hypot(dAdx, dAdz)) / r;
  }

  private computeDerived(): void {
    const m = this.meta!, f = this.fer!, a = this.air!, g = f.grid;
    const ax = m.axisym;
    const energy = (p: Problem & { A: Float32Array }) => {
      let w = 0;
      for (let k = 0; k < p.A.length; k++) {
        const b = this.bAt(p, k);
        const dV = (g.dx * 1e-3) * (g.dy * 1e-3) *                      // planar: per unit depth;
          (ax ? Math.PI * Math.abs(g.y0 + (Math.floor(k / g.nx) + 0.5) * g.dy - ax.axis_z) * 1e-3 : 1);  // axisym: pi|r| per half
        w += 0.5 * b * b / MU0 * p.nuMat[k] * dV;                       // B·H/2
      }
      return w;
    };
    const depth = ax ? 1 : m.coil_depth * 1e-3;
    const wf = energy(f);
    const [[, bz0], [, bz1]] = m.body;
    const kc = (x: number, z: number) => Math.floor((z - g.y0) / g.dy) * g.nx + Math.floor((x - g.x0) / g.dx);
    const zm = (bz0 + bz1) / 2;
    // Ampere check around the -X conductor group: net flux of nu grad A out of a cell box
    const minus = m.cuts.filter((c) => c.dir < 0);
    const xa = Math.min(...minus.map((c) => c.x[0])) - 0.02, xb = Math.max(...minus.map((c) => c.x[1])) + 0.02;
    const za = Math.min(...minus.map((c) => c.z[0])) - 0.02, zb = Math.max(...minus.map((c) => c.z[1])) + 0.02;
    const i0 = Math.floor((xa - g.x0) / g.dx), i1 = Math.floor((xb - g.x0) / g.dx);
    const j0 = Math.floor((za - g.y0) / g.dy), j1 = Math.floor((zb - g.y0) / g.dy);
    const hm = (p: number, q: number) => (2 * p * q) / (p + q);
    let loop = 0, enc = 0;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * g.nx + i;
      enc += f.src[k] * g.dx * g.dy;
      const nb: [number, number][] = [[k - 1, g.dy / g.dx], [k + 1, g.dy / g.dx], [k - g.nx, g.dx / g.dy], [k + g.nx, g.dx / g.dy]];
      const inside = (q: number) => { const qi = q % g.nx, qj = Math.floor(q / g.nx); return qi >= i0 && qi <= i1 && qj >= j0 && qj <= j1; };
      for (const [q, gf] of nb) if (!inside(q)) loop += hm(f.nu[k], f.nu[q]) * (f.A[k] - f.A[q]) * gf;
    }
    const pw = m.probe?.window ?? [0, zm], pa = m.probe?.above ?? [0, bz1 + 0.2];
    this.derived = {
      L2d: 2 * wf * depth, bWindow: this.bAt(f, kc(pw[0], pw[1])), bWindowAir: this.bAt(a, kc(pw[0], pw[1])),
      bAbove: this.bAt(f, kc(pa[0], pa[1])), ampereLoop: loop, ampereEnclosed: enc,
    };
    // display reference: 99th percentile of |B| in the ferrite at 1 A
    const vals: number[] = [];
    for (let k = 0; k < f.A.length; k++) if (f.fe[k]) vals.push(this.bAt(f, k));
    vals.sort((p, q) => p - q);
    this.bRef = vals[Math.floor(vals.length * 0.99)] || 1;
  }

  private writeTexture(): void {
    const f = this.fer!, a = this.air!, g = f.grid, n = g.nx * g.ny;
    let amax = 0;
    for (let k = 0; k < n; k++) amax = Math.max(amax, Math.abs(f.A[k]));
    const h = THREE.DataUtils.toHalfFloat, data = new Uint16Array(n * 4);
    for (let k = 0; k < n; k++) {
      data[4 * k] = h(f.A[k] / (amax || 1));                 // signed: induced E ∝ -dA/dt
      data[4 * k + 1] = h(Math.min(4, this.bAt(f, k) / this.bRef));
      data[4 * k + 2] = h(Math.min(4, this.bAt(a, k) / this.bRef));
      data[4 * k + 3] = h(1);
    }
    this.tex?.dispose();
    this.tex = new THREE.DataTexture(data, g.nx, g.ny, THREE.RGBAFormat, THREE.HalfFloatType);
    this.tex.magFilter = this.tex.minFilter = THREE.LinearFilter;
    this.tex.needsUpdate = true;
    this.U.uFieldTex.value = this.tex;
  }

  // ------------------------------------------------------------------ overlays
  /** Field lines = contours of A at equal steps (equal flux between neighbours), oriented along B. */
  private buildFieldLines(): void {
    const f = this.fer!, g = f.grid, m = this.meta!;
    let amax = 0;
    for (const v of f.A) amax = Math.max(amax, Math.abs(v));
    const K = 9, levels: number[] = [];
    for (let k = 0; k < K; k++) { const v = amax * (k + 0.5) / K; levels.push(v, -v); }
    const segs: number[] = [];
    this.flux = [];
    for (const c of contours(g, f.A, levels)) {
      let pts = c.pts;
      // orient along B = (-dA/dz, dA/dx)
      const mid = Math.floor(pts.length / 4) * 2;
      const tx = pts[mid + 2] - pts[mid], tz = pts[mid + 3] - pts[mid + 1];
      const bx = -(sample(g, f.A, pts[mid], pts[mid + 1] + g.dy) - sample(g, f.A, pts[mid], pts[mid + 1] - g.dy));
      const bz = sample(g, f.A, pts[mid] + g.dx, pts[mid + 1]) - sample(g, f.A, pts[mid] - g.dx, pts[mid + 1]);
      const flip = m.axisym && pts[mid + 1] < m.axisym.axis_z ? -1 : 1;
      if ((tx * bx + tz * bz) * flip < 0) {
        const r: number[] = [];
        for (let i = pts.length - 2; i >= 0; i -= 2) r.push(pts[i], pts[i + 1]);
        pts = r;
      }
      const len = [0], speed: number[] = [];
      for (let i = 0; i < pts.length; i += 2) {
        if (i) len.push(len[len.length - 1] + Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]));
        const k = Math.floor((pts[i + 1] - g.y0) / g.dy) * g.nx + Math.floor((pts[i] - g.x0) / g.dx);
        speed.push(this.bAt(f, Math.max(0, Math.min(k, f.A.length - 1))) / this.bRef);
        if (i) segs.push(pts[i - 2], Y_OVERLAY, pts[i - 1], pts[i], Y_OVERLAY, pts[i + 1]);
      }
      this.flux.push({ pts: Float32Array.from(pts), len: Float32Array.from(len), speed: Float32Array.from(speed) });
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(segs, 3));
    this.lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xd8ffe4, transparent: true, opacity: 0.6, depthWrite: false }));
    this.lines.renderOrder = 20_001;
    this.overlay.add(this.lines);
    // flux markers, spaced along each line
    this.fluxS = [];
    this.flux.forEach((l, i) => {
      const L = l.len[l.len.length - 1];
      for (let s = (i * 0.017) % 0.09; s < L; s += 0.09) this.fluxS.push({ line: i, s });
    });
    const dg = new THREE.BufferGeometry();
    dg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.fluxS.length * 3), 3));
    this.fluxDots = new THREE.Points(dg, new THREE.PointsMaterial({ size: 4, sizeAttenuation: false, color: 0xeaffb0, transparent: true, depthWrite: false }));
    this.fluxDots.renderOrder = 20_002;
    this.fluxDots.frustumCulled = false;
    this.overlay.add(this.fluxDots);
  }

  /** ⊙ / ⊗ on each conductor cut (current toward / away from a viewer on the -Y side). */
  private buildCutGlyphs(): void {
    for (const dir of [1, -1]) {
      const pos: number[] = [];
      for (const c of this.meta!.cuts) if (c.dir === dir) pos.push((c.x[0] + c.x[1]) / 2, Y_OVERLAY * 1.4, (c.z[0] + c.z[1]) / 2);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      const p = new THREE.Points(geo, new THREE.PointsMaterial({ size: 13, sizeAttenuation: false, transparent: true, depthWrite: false, alphaTest: 0.05 }));
      p.userData.dir = dir;
      p.renderOrder = 20_003;
      this.overlay.add(p);
      this.cutDots.push(p);
    }
  }

  /** Current markers along the conductor's centre-line (lead, sheets, vias, lead). */
  private buildCoilDots(): void {
    const path = this.meta!.coil_path;
    const pts: number[] = [], len = [0];
    path.forEach((p, i) => {
      pts.push(...p);
      if (i) len.push(len[i - 1] + Math.hypot(p[0] - path[i - 1][0], p[1] - path[i - 1][1], p[2] - path[i - 1][2]));
    });
    this.coilPts = Float32Array.from(pts);
    this.coilLen = Float32Array.from(len);
    const L = len[len.length - 1];
    this.coilS = [];
    for (let s = 0; s < L; s += 0.035) this.coilS.push(s);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.coilS.length * 3), 3));
    this.coilDots = new THREE.Points(geo, new THREE.PointsMaterial({ size: 5, sizeAttenuation: false, color: 0xffb347, transparent: true, depthWrite: false }));
    this.coilDots.renderOrder = 20_004;
    this.coilDots.frustumCulled = false;
    this.model!.root.add(this.coilDots);             // 3D, clipped by the section like the part
  }

  private syncClipping(): void {
    if (!this.coilDots) return;
    const mat = this.coilDots.material as THREE.Material;
    mat.clippingPlanes = this.section.enabled ? [this.section.plane] : [];
    mat.needsUpdate = true;
  }

  private detach(): void {
    this.overlay.removeFromParent();
    for (const o of [...this.overlay.children, ...(this.coilDots ? [this.coilDots] : [])]) {
      o.removeFromParent();
      (o as THREE.Mesh).geometry?.dispose();
      ((o as THREE.Mesh).material as THREE.Material)?.dispose();
    }
    this.lines = this.fluxDots = this.coilDots = null;
    this.cutDots = [];
    if (this.model && this.meta) for (const id of this.meta.core_layers ?? [this.meta.core_layer]) this.model.setVisible(id, true);
    this.seq = null;
    this.meta = null;
  }

  // ------------------------------------------------------------------ controls
  setOn(on: boolean): void {
    this.state.on = on;
    if (!on) this.seq = null;
    this.applyState();
  }

  play(instant = false): void {
    if (!this.meta) return;
    Object.assign(this.state, { on: true, ac: false, field: true, fieldLines: true, flow: true, coilCurrent: true, core: true });
    this.seq = instant ? null : { t: 0 };
    this.applyState();
  }

  set<K extends keyof CoilState>(key: K, value: CoilState[K]): void {
    this.state[key] = value;
    if (key === "ac") this.seq = null;
    this.applyState();
  }

  /** Instantaneous normalised current i (−1..1 in AC, 0..1 while energising) and di/dt. */
  private drive(): { i: number; di: number } {
    const s = this.state;
    if (s.ac) return { i: Math.sin(this.theta), di: Math.cos(this.theta) };
    if (this.seq) {
      const t = Math.max(0, this.seq.t - 0.3);
      return { i: 1 - Math.exp(-t / TAU), di: this.seq.t < 0.3 ? 0 : Math.exp(-t / TAU) };
    }
    return { i: 1, di: 0 };
  }

  /** Amplitude used for the field scale: DC current, or AC peak. */
  private amps(): number {
    return this.state.ac ? this.state.acAmp : this.state.current;
  }

  private applyState(): void {
    const m = this.meta, model = this.model;
    if (!m || !model) return;
    const s = this.state, U = this.U;
    U.uOn.value = s.on ? 1 : 0;
    this.overlay.visible = s.on;
    if (this.coilDots) this.coilDots.visible = s.on && s.coilCurrent;
    for (const id of m.core_layers ?? [m.core_layer]) model.setVisible(id, !(s.on && !s.core));
    if (m.shield_layer) model.setVisible(m.shield_layer, !(s.on && (!s.core || !s.shield)));
    this.section.syncVisibility();
    if (s.ac && s.paused) this.theta = (s.phaseDeg * Math.PI) / 180;
    this.frame();
    this.viewer.invalidate();
    this.onChange();
  }

  /** Push the instantaneous state to uniforms and overlays. */
  private frame(): void {
    const s = this.state, U = this.U;
    const { i, di } = this.drive();
    const sat = this.saturation(Math.abs(i) * this.amps());
    const scale = (this.amps() / this.meta!.electrical.rated_current_a) * sat;   // B relative to rated
    const p = (key: string) => {
      if (!this.seq) return 1;
      const st = STAGES.find((x) => x.key === key)!;
      return smooth((this.seq.t - st.start) / (st.end - st.start));
    };
    U.uVolt.value = 1;
    U.uField.value = 1;
    U.uShowPot.value = s.induced || (this.seq !== null && this.seq.t < 3.2) ? 1 : 0;
    U.uAcScale.value = -di;                                   // induced E ∝ −dA/dt ∝ −dI/dt
    U.uHeatMix.value = s.field ? (this.seq ? p("build") : 1) : 0;
    U.uHeatGain.value = 0.62 * Math.abs(i) * Math.min(2, scale);
    U.uCore.value = this.seq ? p("core") : 1;
    const shown = Math.abs(i) * (this.seq ? p("build") : 1);
    if (this.lines) {
      this.lines.visible = s.fieldLines;
      (this.lines.material as THREE.LineBasicMaterial).opacity = 0.6 * (0.15 + 0.85 * shown) * (this.seq ? p("core") * 0.7 + 0.3 : 1);
    }
    if (this.fluxDots) {
      this.fluxDots.visible = s.flow && s.fieldLines;
      (this.fluxDots.material as THREE.PointsMaterial).opacity = shown;
    }
    for (const c of this.cutDots) {
      const away = (c.userData.dir as number) * (i >= 0 ? 1 : -1) > 0;   // +y current: away from the viewer
      (c.material as THREE.PointsMaterial).map = glyph(away ? "x" : "o");
      (c.material as THREE.PointsMaterial).opacity = Math.min(1, 0.25 + Math.abs(i));
      (c.material as THREE.PointsMaterial).needsUpdate = true;
    }
  }

  /** Illustrative ferrite saturation: L_eff / L = 1 / (1 + (I / I_half)^2). */
  saturation(I: number): number {
    return 1 / (1 + (I / this.meta!.electrical.sat_i_half_a) ** 2);
  }

  private tick(dt: number): boolean {
    if (!this.meta || !this.state.on) return false;
    const s = this.state;
    let animating = false;
    if (this.seq) {
      this.seq.t += dt;
      if (this.seq.t > STAGES[STAGES.length - 1].end + 0.3) this.seq = null;
      animating = true;
    } else if (s.ac && !s.paused) {
      this.theta = (this.theta + 2 * Math.PI * AC_VIS_HZ * dt) % (2 * Math.PI);
      s.phaseDeg = Math.round((this.theta * 180) / Math.PI);
      animating = true;
    }
    const { i } = this.drive();
    const moving = (s.flow || s.coilCurrent) && Math.abs(i) > 1e-3 && !(s.ac && s.paused);
    if (moving) { this.advance(dt, i); animating = true; }
    if (animating) { this.frame(); this.onChange(); }
    return animating;
  }

  private advance(dt: number, i: number): void {
    const gain = Math.min(2.5, this.amps() / this.meta!.electrical.rated_current_a + 0.2);
    // flux markers: speed ∝ local |B| and the instantaneous current, direction follows B
    if (this.fluxDots?.visible) {
      const pos = this.fluxDots.geometry.getAttribute("position") as THREE.BufferAttribute;
      this.fluxS.forEach((p, idx) => {
        const l = this.flux[p.line], L = l.len[l.len.length - 1];
        const k = locate(l.len, p.s);
        p.s += 0.18 * gain * i * Math.min(3, l.speed[k] + 0.15) * dt;
        p.s = ((p.s % L) + L) % L;
        const kk = locate(l.len, p.s), u = kk < l.len.length - 1 ? (p.s - l.len[kk]) / (l.len[kk + 1] - l.len[kk] || 1) : 0;
        pos.setXYZ(idx, l.pts[2 * kk] + u * ((l.pts[2 * kk + 2] ?? l.pts[2 * kk]) - l.pts[2 * kk]), Y_OVERLAY * 1.2,
          l.pts[2 * kk + 1] + u * ((l.pts[2 * kk + 3] ?? l.pts[2 * kk + 1]) - l.pts[2 * kk + 1]));
      });
      pos.needsUpdate = true;
    }
    // conduction current along the helix
    if (this.coilDots?.visible) {
      const pos = this.coilDots.geometry.getAttribute("position") as THREE.BufferAttribute;
      const L = this.coilLen[this.coilLen.length - 1], P = this.coilPts;
      this.coilS.forEach((s0, idx) => {
        let s = s0 + 0.35 * gain * i * dt;
        s = ((s % L) + L) % L;
        this.coilS[idx] = s;
        const k = locate(this.coilLen, s), u = k < this.coilLen.length - 1 ? (s - this.coilLen[k]) / (this.coilLen[k + 1] - this.coilLen[k] || 1) : 0;
        const k3 = 3 * k, n3 = Math.min(3 * (k + 1), P.length - 3);
        pos.setXYZ(idx, P[k3] + u * (P[n3] - P[k3]), P[k3 + 1] + u * (P[n3 + 1] - P[k3 + 1]), P[k3 + 2] + u * (P[n3 + 2] - P[k3 + 2]));
      });
      pos.needsUpdate = true;
    }
  }

  /** Shield in / out: re-solve with or without the shield ferrite and redraw the field lines. */
  setShield(on: boolean): void {
    if (!this.meta) return;
    this.state.shield = on;
    this.fer = solvePoissonLadder((nx) => this.problem(nx, true), this.meta!.grid_nx ?? NX, !!this.meta!.axisym);
    this.computeDerived();
    this.writeTexture();
    for (const o of [this.lines, this.fluxDots]) {
      if (!o) continue;
      o.removeFromParent();
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
    this.buildFieldLines();
    this.applyState();
  }

  // ------------------------------------------------------------------ readouts
  readout() {
    const m = this.meta;
    if (!m) return null;
    const e = m.electrical, I = this.state.current, sat = this.saturation(I);
    // an axisymmetric solve is a true 3D inductance (and follows the shield toggle)
    const L = (m.axisym ? this.derived.L2d : e.inductance_h) * sat;
    const t = this.seq?.t ?? null;
    return {
      I, L, L0: e.inductance_h, sat, W: 0.5 * L * I * I, Vdrop: I * e.dcr_ohm, Ploss: I * I * e.dcr_ohm, rated: e.rated_current_a,
      bWindow: this.derived.bWindow * I * sat, bAirRatio: this.derived.bWindow / this.derived.bWindowAir,
      L2d: this.derived.L2d, turns: m.turns, muR: e.mu_r, axisym: !!m.axisym, shield: this.state.shield,
      hasShield: !!m.ferrite?.some((f) => f.group === "shield"), bAbove: this.derived.bAbove * I * sat,
      stage: t !== null ? STAGES.find((x) => t < x.end)?.caption ?? null : null,
      tNorm: t !== null ? Math.max(0, t - 0.3) / TAU : null,
    };
  }

  readoutAc() {
    const m = this.meta;
    if (!m) return null;
    const e = m.electrical, f = 10 ** this.state.freqLog, w = 2 * Math.PI * f;
    // real part: (R + jwL) in parallel with the turn-to-turn capacitance
    const zr = e.dcr_ohm, zi = w * e.inductance_h;                 // series branch
    const yr = zr / (zr * zr + zi * zi), yi = -zi / (zr * zr + zi * zi) + w * e.parasitic_c_f;
    const den = yr * yr + yi * yi, Zr = yr / den, Zi = -yi / den;
    const Z = Math.hypot(Zr, Zi), phaseDeg = (Math.atan2(Zi, Zr) * 180) / Math.PI;   // > 0: inductive (V leads I)
    const I0 = this.state.acAmp, RL = e.filter_load_ohm;
    const s = Math.sin(this.theta), c = Math.cos(this.theta);
    const caption = Math.abs(s) > 0.92
      ? "Current at its peak: B and the stored energy are maximal but momentarily constant, so the induced voltage is ~0."
      : Math.abs(c) > 0.92
        ? "Current crossing zero: the flux is changing fastest, so the induced back-EMF peaks — voltage leads current by 90°."
        : "Energy flows into the field while |I| grows and back out while it falls; B follows the current.";
    return {
      f, I0, Z, phaseDeg, XL: w * e.inductance_h, V0: I0 * Z, srf: 1 / (2 * Math.PI * Math.sqrt(e.inductance_h * e.parasitic_c_f)),
      atten: RL / Math.hypot(RL + Zr, Zi), RL, L: e.inductance_h, dcr: e.dcr_ohm, cpar: e.parasitic_c_f,
      theta: this.theta, s, c, caption, bPeak: this.derived.bWindow * I0,
    };
  }

  /** For tests. */
  diagnostics() {
    return { ...this.derived, iters: 0 };
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

const glyphs = new Map<string, THREE.Texture>();
/** "o" = ⊙ (current toward the viewer), "x" = ⊗ (away). */
function glyph(kind: "o" | "x"): THREE.Texture {
  const hit = glyphs.get(kind);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d")!;
  g.fillStyle = "rgba(10,12,16,0.85)";
  g.beginPath(); g.arc(16, 16, 14, 0, Math.PI * 2); g.fill();
  g.strokeStyle = "#ffb347"; g.fillStyle = "#ffb347"; g.lineWidth = 3;
  g.beginPath(); g.arc(16, 16, 12, 0, Math.PI * 2); g.stroke();
  if (kind === "o") { g.beginPath(); g.arc(16, 16, 3.5, 0, Math.PI * 2); g.fill(); }
  else { g.beginPath(); g.moveTo(9, 9); g.lineTo(23, 23); g.moveTo(23, 9); g.lineTo(9, 23); g.stroke(); }
  const t = new THREE.CanvasTexture(c);
  glyphs.set(kind, t);
  return t;
}
