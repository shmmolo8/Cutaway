import * as THREE from "three";
import type { ComponentModel } from "../model";
import type { SectionTool } from "../section";
import type { PlatePhysicsMeta } from "../types";
import type { Viewer } from "../viewer";
import { injectPhysics, makeUniforms, ROLE, type PhysicsUniforms } from "./shading";
import { FILM, HIGH, LOW, makeGrid, sample, solveLadder, type Grid, type Solution } from "./solver";

const NX = 240;
const EPS0 = 8.854e-12;
const Y_OVERLAY = -0.0015;       // overlays sit just in front of the y = 0 section (camera side)
const TAU = 0.45;                // charging time constant shown in the sequence (s, animation time)

const STAGES = [
  { key: "volt", start: 0.0, end: 1.0, caption: "1 · Voltage applied: each termination and every plate joined to it jump to + or 0 V" },
  { key: "charge", start: 1.0, end: 3.4, caption: "2 · Charging: current flows in until the plates hold the charge Q = CV, then stops — a capacitor blocks DC" },
  { key: "field", start: 2.0, end: 4.0, caption: "3 · The field forms: it lives in the thin ceramic between plates of opposite polarity" },
  { key: "polar", start: 4.0, end: 6.0, caption: "4 · BaTiO₃ polarises: its dipoles align with the field — that's why εr ≈ 2500" },
  { key: "fringe", start: 6.0, end: 8.0, caption: "5 · Field strength peaks at the electrode tips; the margins keep that away from the surface" },
] as const;

export interface CapState {
  on: boolean;
  voltage: number;
  potential: boolean;
  lines: boolean;          // equipotentials
  strength: boolean;       // |E| palette instead of potential
  fieldLines: boolean;
  charges: boolean;
  dipoles: boolean;
  ac: boolean;             // AC supply: V(t) = V0 sin(wt)
  acAmp: number;           // AC peak amplitude (V): ripple / noise scale, not the DC rail
  freqLog: number;         // log10 of the real supply frequency (Hz)
  displacement: boolean;   // colour by displacement current eps dE/dt instead of |E|
  designD: number;         // what-if: dielectric thickness (µm)
  designDia: number;       // what-if: electrode diameter (mm), disc plates
  designEps: number;       // what-if: eps_r
  paused: boolean;         // freeze the AC phase (scrub with phaseDeg)
  phaseDeg: number;
}

/** AC behaviour of the real part (ideal C plus typical ESR/ESL). */
export interface AcReadout {
  f: number; V0: number; C: number; Xc: number; Z: number; phaseDeg: number; srf: number; esr: number; esl: number;
  Iamp: number; atten: number; rs: number; Jd: number; polarFrac: number; s: number; c: number; theta: number;
  caption: string;
}

const AC_VIS_HZ = 0.35;          // animation rate of one AC cycle (the real f is shown in the readout)

export interface CapReadout {
  V: number; C: number; Cideal: number; Q: number; W: number; epsR: number;
  Creal: number; CrealBias: number; biasFactor: number; Ereal: number; dReal: number;
  gaps: number; gapUm: number; stage: string | null; tNorm: number | null;
  fringe: number;          // solved section flux / ideal parallel-plate flux
  Cdesign: number;         // what-if C from the design sliders (disc: eps0 eps_r pi r^2 / d x fringe)
  Edesign: number;         // V / d of the what-if design (V/µm)
}

/**
 * Electrostatics of a multilayer capacitor in its longitudinal section (metadata
 * `physics.type = "plate_capacitor"`). The 2D Laplace solution is extruded across the
 * electrode width; C = eps0 * eps_r * flux * width.
 */
export class PlatePhysics {
  readonly U: PhysicsUniforms = makeUniforms();
  readonly state: CapState = {
    on: false, voltage: 0, potential: true, lines: true, strength: false, fieldLines: true, charges: true, dipoles: true,
    ac: false, acAmp: 0.1, freqLog: 6, displacement: false, paused: false, phaseDeg: 0,
    designD: 0, designDia: 0, designEps: 0,
  };
  meta: PlatePhysicsMeta | null = null;
  onChange: () => void = () => {};

  private viewer: Viewer;
  private section: SectionTool;
  private grid: Grid | null = null;
  private sol: Solution | null = null;
  private eRef = 1;
  private tex: THREE.DataTexture | null = null;
  private overlay = new THREE.Group();
  private fieldLines: THREE.LineSegments | null = null;
  private charges: { pts: THREE.Points; platesPositive: boolean; plus: boolean }[] = [];
  private arrows: THREE.ArrowHelper[] = [];
  private theta = 0;
  private dipSign = 1;
  private dipScale = 1;
  private dipoles: THREE.LineSegments | null = null;
  private dipoleData: { x: number; z: number; ex: number; ez: number; s: number; a0: number }[] = [];
  private seq: { t: number } | null = null;
  private align = 1;
  private chargeLevel = 1;
  private base: PlatePhysicsMeta | null = null;          // the part as built (design sliders start here)
  private model: ComponentModel | null = null;
  private origPos = new Map<string, Float32Array>();     // as-built vertex positions of reshaped layers
  private redesignQueued: number | null = null;

  constructor(viewer: Viewer, section: SectionTool) {
    this.viewer = viewer;
    this.section = section;
    this.overlay.name = "capacitor-physics";
    viewer.onFrame((dt) => this.tick(dt));
  }

  get available(): boolean {
    return !!this.meta;
  }

  attach(model: ComponentModel): boolean {
    this.detach();

    const meta = model.meta.physics;
    this.meta = meta?.type === "plate_capacitor" ? meta : null;
    if (!this.meta) return false;
    const m = this.meta, U = this.U;
    const [[x0, z0], [x1, z1]] = m.domain;
    U.uDomainMin.value.set(x0, z0);
    U.uDomainSize.value.set(x1 - x0, z1 - z0);
    model.group.updateMatrixWorld(true);
    // the solver works in its own frame (x along the plates, z across them, section y = 0)
    const fm = new THREE.Matrix4();
    if (m.frame) {
      const v = (a: number[]) => new THREE.Vector3(a[0], a[1], a[2]);
      fm.makeBasis(v(m.frame.x), v(m.frame.y), v(m.frame.z)).setPosition(v(m.frame.origin));
    }
    this.overlay.matrixAutoUpdate = false;
    this.overlay.matrix.copy(fm);
    U.uWorldToCad.value.copy(model.root.matrixWorld).multiply(fm).invert();
    U.uLineCount.value = m.line_count;
    U.uLineAlpha.value = 0.6;
    U.uPalette.value = 1;
    U.uHeatEmit.value = 0.25;
    U.uHeatGain.value = 0.62;
    if (!this.state.voltage) this.state.voltage = m.electrical.rated_voltage_v / 2;
    // design what-if sliders start at the real part
    this.state.designD = m.electrical.real_part.dielectric_um;
    this.state.designDia = +(m.overlap.x[1] - m.overlap.x[0]).toFixed(2);
    this.state.designEps = m.electrical.epsilon_r;

    for (const l of model.layers) {
      const id = l.meta.id;
      const role = id === m.dielectric_layer ? ROLE.FILM
        : m.contacts.positive.includes(id) ? ROLE.POSITIVE
          : m.contacts.negative.includes(id) ? ROLE.NEGATIVE : 0;
      if (!role) continue;
      injectPhysics(l.material, role, U, "xz");
      const cap = this.section.capMaterial(id);
      if (cap) injectPhysics(cap, role, U, "xz");
    }

    this.base = m;
    this.model = model;
    if (m.design) this.section.drawLast(Object.keys(m.design.layers));
    this.origPos.clear();
    this.rebuild();
    model.root.add(this.overlay);
    this.applyState();
    return true;
  }

  /** Solve the current meta's geometry and (re)build the texture and overlays. */
  private rebuild(): void {
    const m = this.meta!, U = this.U;
    this.clearOverlay();
    const { grid, sol } = solveLadder((nx) => this.rasterise(nx), NX);
    this.grid = grid;
    this.sol = sol;
    U.uDomainMin.value.set(grid.x0, grid.y0);
    U.uDomainSize.value.set(grid.nx * grid.dx, grid.ny * grid.dy);
    this.eRef = 1 / m.overlap.gap;              // ideal uniform field between plates (V = 1)
    this.writeTexture();
    this.buildFieldLines();
    this.buildCharges();
    this.buildDipoles();
    this.buildArrows();
  }

  /**
   * Disc design sliders: reshape the part (ceramic thickness d, electrode diameter), shift the
   * leads with the faces, and re-solve the field in the new geometry. Drawn thickness scales
   * with d / d_real, so the exaggerated variant stays proportional.
   */
  redesign(): void {
    if (!this.base?.design || this.redesignQueued !== null) return;
    this.redesignQueued = requestAnimationFrame(() => {
      this.redesignQueued = null;
      const b = this.base!, d = b.design!, s = this.state, model = this.model!;
      const g0 = b.overlap.gap, g = g0 * (s.designD / b.electrical.real_part.dielectric_um);
      const te = b.plates[0].z[1] - b.plates[0].z[0];
      const re0 = (b.overlap.x[1] - b.overlap.x[0]) / 2;
      const re = Math.min(s.designDia / 2, b.domain[1][0] * 0.98);
      s.designDia = 2 * re;
      const shift = (g - g0) / 2, kR = re / re0, [cx, , cz] = d.center;
      this.meta = {
        ...b, electrode_width: 2 * re, overlap: { ...b.overlap, x: [-re, re], gap: g },
        domain: [[b.domain[0][0], -(g / 2 + te)], [b.domain[1][0], g / 2 + te]],
        plates: b.plates.map((p) => ({ ...p, x: [-re, re] as [number, number],
          z: (p.z[0] < 0 ? [-(g / 2 + te), -g / 2] : [g / 2, g / 2 + te]) as [number, number] })),
      };
      for (const [id, [kind, side, z0, z1]] of Object.entries(d.layers)) {
        // optional z ramp: no shift below z0, full shift above z1 (a lead's pin stays in its hole)
        const w = (z: number) => (z0 === undefined || z1 === undefined ? 1 : THREE.MathUtils.clamp((z - z0) / (z1 - z0), 0, 1));
        const l = model.byId.get(id);
        if (!l) continue;
        const attr = l.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
        if (!this.origPos.has(id)) this.origPos.set(id, Float32Array.from(attr.array as Float32Array));
        const o = this.origPos.get(id)!, a = attr.array as Float32Array;
        for (let i = 0; i < o.length; i += 3) {
          const x = o[i], y = o[i + 1], z = o[i + 2];
          if (kind === "dielectric") { a[i] = x; a[i + 1] = y * (g / g0); a[i + 2] = z; }
          else if (kind === "plate") { a[i] = cx + (x - cx) * kR; a[i + 1] = y + side * shift; a[i + 2] = cz + (z - cz) * kR; }
          else { a[i] = x; a[i + 1] = y + side * shift * w(z); a[i + 2] = z; }
        }
        attr.needsUpdate = true;
        l.mesh.geometry.computeBoundingBox();
        l.mesh.geometry.computeBoundingSphere();
      }
      this.rebuild();
      this.applyState();
    });
  }

  /** Field, charge density and polarisation of the design relative to the part as built. */
  private designScale() {
    const b = this.base, s = this.state;
    if (!b?.design) return { kE: 1, kSigma: 1, kP: 1 };
    const e = b.electrical, kE = e.real_part.dielectric_um / s.designD;        // E = V/d
    return { kE, kSigma: kE * (s.designEps / e.epsilon_r), kP: kE * ((s.designEps - 1) / (e.epsilon_r - 1)) };
  }

  // ------------------------------------------------------------------ controls
  setOn(on: boolean): void {
    this.state.on = on;
    if (!on) this.seq = null;
    this.applyState();
  }

  play(instant = false): void {
    if (!this.meta) return;
    Object.assign(this.state, { on: true, potential: true, lines: true, fieldLines: true, charges: true, dipoles: true, strength: true });
    this.seq = instant ? null : { t: 0 };
    this.applyState();
  }

  set<K extends keyof CapState>(key: K, value: CapState[K]): void {
    this.state[key] = value;
    this.applyState();
  }

  /** Dimensionless flux (V = 1) per unit depth from the solution. */
  flux(): number {
    return this.sol ? (this.sol.iIn + this.sol.iOut) / 2 : 0;
  }

  readout(): CapReadout | null {
    const m = this.meta;
    if (!m || !this.sol) return null;
    const e = m.electrical, w = m.electrode_width * 1e-3;
    const disc = m.plate_shape === "disc", s = this.state;
    const epsR = disc ? s.designEps : e.epsilon_r;
    const ov = (m.overlap.x[1] - m.overlap.x[0]) * 1e-3;
    // 2D section: extra flux over the ideal parallel plates is fringing at the plate edges
    const fringe = this.flux() / ((m.overlap.gaps * ov) / (m.overlap.gap * 1e-3));
    const area = disc ? Math.PI * (ov / 2) ** 2 : ov * w;
    // a disc uses its true thickness d (the design value; even when films are exaggerated)
    const gap = disc ? s.designD * 1e-6 : m.overlap.gap * 1e-3;
    const Cideal = (EPS0 * epsR * m.overlap.gaps * area) / gap;
    // rectangular plates: the section extruded across the width; a disc: ideal x section fringing
    const C = disc ? Cideal * fringe : EPS0 * epsR * this.flux() * w;
    const Cdesign = disc ? C : (EPS0 * s.designEps * m.overlap.gaps * area) / (s.designD * 1e-6) * fringe;
    const V = this.state.voltage;
    const dReal = e.real_part.dielectric_um;
    const Ereal = V / dReal;                                   // V/µm in the real part
    const biasFactor = 1 / (1 + (Ereal / e.dc_bias_e_half_v_per_um) ** 2);
    const t = this.seq?.t ?? null;
    const stage = t !== null ? STAGES.find((s) => t < s.end)?.caption ?? null : null;
    const tNorm = t !== null && t >= 1 ? (t - 1) / TAU : null;
    return {
      V, C, Cideal, Q: C * V, W: 0.5 * C * V * V, epsR,
      Creal: e.real_part.capacitance_f, CrealBias: e.real_part.capacitance_f * biasFactor, biasFactor, Ereal, dReal,
      gaps: m.overlap.gaps, gapUm: m.overlap.gap * 1000, stage, tNorm,
      fringe, Cdesign, Edesign: V / s.designD,
    };
  }

  // ------------------------------------------------------------------ solve
  /**
   * Grid aligned to the stack: dz divides the plate pitch and (nearly) the plate thickness,
   * and the origin puts plate faces on cell faces, so every gap is resolved exactly.
   */
  private rasterise(nx: number): Grid {
    const m = this.meta!;
    const [[x0, z0], [x1, z1]] = m.domain;
    const pl = [...m.plates].sort((a, b) => a.z[0] - b.z[0]);
    const pitch = pl.length > 1 ? pl[1].z[0] - pl[0].z[0] : z1 - z0;
    const tEl = pl[0].z[1] - pl[0].z[0];
    const scale = nx / NX;                                  // coarse ladder levels
    let best = { m: 12, err: Infinity };
    for (let k = 10; k <= 24; k++) {
      const r = (tEl * k) / pitch, err = r < 0.5 ? 1 : Math.abs(r - Math.round(r));
      if (err < best.err - 1e-9) best = { m: k, err };
    }
    const dz = pitch / Math.max(3, Math.round(best.m * scale));
    const zStart = pl[0].z[0] - Math.ceil((pl[0].z[0] - z0) / dz - 1e-9) * dz;   // plate face on a cell face
    const ny = Math.ceil((z1 - zStart) / dz - 1e-9);
    const g = makeGrid(x0, zStart, x1, zStart + ny * dz, nx, dz);
    const set = (i: number, j: number, t: number) => { g.type[j * g.nx + i] = t; };
    for (const p of m.plates) {
      const t = p.potential ? HIGH : LOW;
      const zc = (p.z[0] + p.z[1]) / 2;
      const half = Math.max(Math.round((p.z[1] - p.z[0]) / g.dy) / 2, 0.5) * g.dy + 1e-9;   // whole rows, >= 1
      for (let j = 0; j < g.ny; j++) {
        const z = g.y0 + (j + 0.5) * g.dy;
        if (Math.abs(z - zc) > half) continue;
        for (let i = 0; i < g.nx; i++) {
          const x = g.x0 + (i + 0.5) * g.dx;
          if (x >= p.x[0] && x <= p.x[1]) set(i, j, t);
        }
      }
    }
    // termination: whole end faces, and the band on the top/bottom surfaces
    if (m.end_terminations !== false) for (let j = 0; j < g.ny; j++) { set(0, j, HIGH); set(g.nx - 1, j, LOW); }
    for (let i = 0; i < g.nx; i++) {
      const x = g.x0 + (i + 0.5) * g.dx;
      if (x <= -m.band_inner_x) { set(i, 0, HIGH); set(i, g.ny - 1, HIGH); }
      if (x >= m.band_inner_x) { set(i, 0, LOW); set(i, g.ny - 1, LOW); }
    }
    return g;
  }

  private writeTexture(): void {
    const g = this.grid!, s = this.sol!;
    const n = g.nx * g.ny;
    const h = THREE.DataUtils.toHalfFloat;
    const data = new Uint16Array(n * 4);
    for (let k = 0; k < n; k++) {
      const e = Math.sqrt(s.q[k]) / this.eRef;               // |E| relative to the ideal gap field
      data[4 * k] = h(s.V[k]);
      data[4 * k + 1] = h(Math.min(e, 4));
      data[4 * k + 2] = h(0);
      data[4 * k + 3] = h(1);
    }
    this.tex?.dispose();
    this.tex = new THREE.DataTexture(data, g.nx, g.ny, THREE.RGBAFormat, THREE.HalfFloatType);
    this.tex.magFilter = this.tex.minFilter = THREE.LinearFilter;
    this.tex.needsUpdate = true;
    this.U.uFieldTex.value = this.tex;
  }

  // ------------------------------------------------------------------ overlays
  /** E-field lines from every + plate surface, equally spaced in flux. */
  private buildFieldLines(): void {
    const g = this.grid!, s = this.sol!;
    const seeds: { x: number; z: number; f: number }[] = [];
    const { nx, ny, type } = g;
    for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
      const k = j * nx + i;
      if (type[k] !== HIGH) continue;
      for (const [di, dj] of [[1, 0], [0, 1], [0, -1]] as const) {
        const kk = k + di + dj * nx;
        if (type[kk] !== FILM) continue;
        seeds.push({ x: g.x0 + (i + 0.5 + di * 0.55) * g.dx, z: g.y0 + (j + 0.5 + dj * 0.55) * g.dy, f: Math.max(0, s.V[k] - s.V[kk]) * (dj ? g.dx / g.dy : g.dy / g.dx) });
      }
    }
    seeds.sort((a, b) => a.x - b.x || a.z - b.z);
    const total = seeds.reduce((a, b) => a + b.f, 0);
    const count = 150, hstep = 0.35 * Math.min(g.dx, g.dy);
    const segs: number[] = [];
    let acc = 0, si = 0;
    for (let n = 0; n < count && seeds.length; n++) {
      const target = ((n + 0.5) / count) * total;
      while (si < seeds.length - 1 && acc + seeds[si].f < target) acc += seeds[si++].f;
      let x = seeds[si].x, z = seeds[si].z;
      for (let step = 0; step < 4000; step++) {
        const ex = sample(g, s.jx, x, z), ez = sample(g, s.jy, x, z), mag = Math.hypot(ex, ez);
        if (mag < 1e-6) break;
        const nxp = x + (ex / mag) * hstep, nzp = z + (ez / mag) * hstep;
        segs.push(x, Y_OVERLAY, z, nxp, Y_OVERLAY, nzp);
        x = nxp; z = nzp;
        const i = Math.floor((x - g.x0) / g.dx), j = Math.floor((z - g.y0) / g.dy);
        if (i < 0 || j < 0 || i >= nx || j >= ny || type[j * nx + i] !== FILM) break;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(segs, 3));
    this.fieldLines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      color: 0xbfe6ff, transparent: true, opacity: 0.55, depthWrite: false,
    }));
    this.fieldLines.renderOrder = 20_001;
    this.overlay.add(this.fieldLines);
  }

  /** Surface charge on each plate face: density ∝ normal field just outside the face. */
  private buildCharges(): void {
    const m = this.meta!, g = this.grid!, s = this.sol!;
    const spacing = 0.028;
    const make = (positive: boolean, plus: boolean) => {
      const pos: number[] = [], col: number[] = [];
      for (const p of m.plates) {
        if (!!p.potential !== positive) continue;
        for (const side of [1, -1]) {
          const zf = side > 0 ? p.z[1] : p.z[0];
          const zs = zf + side * Math.max(0.6 * g.dy, 0.004);
          for (let x = p.x[0] + spacing / 2; x < p.x[1]; x += spacing) {
            if (x < m.domain[0][0] + 0.01 || x > m.domain[1][0] - 0.01) continue;
            const en = Math.abs(sample(g, s.jy, x, zs)) / this.eRef;
            if (en < 0.04) continue;
            pos.push(x, Y_OVERLAY * 1.3, zf + side * 0.006);
            col.push(1, 1, 1, Math.min(1, en));
          }
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 4));
      const pts = new THREE.Points(geo, new THREE.PointsMaterial({
        size: 9, sizeAttenuation: false, map: glyph(plus ? "+" : "−", plus ? "#ff5a4a" : "#58b4ff"),
        vertexColors: true, transparent: true, depthWrite: false, alphaTest: 0.02,
      }));
      pts.renderOrder = 20_003;
      this.overlay.add(pts);
      this.charges.push({ pts, platesPositive: positive, plus });
    };
    // the + side's plates carry + charge when V > 0 and - charge when V < 0 (AC)
    make(true, true); make(true, false); make(false, false); make(false, true);
  }

  /** Conduction-current arrows outside each termination (AC). */
  private buildArrows(): void {
    const m = this.meta!;
    const [[x0, z0], [x1, z1]] = m.domain;
    const alongZ = m.arrow_axis === "z";
    for (const k of [0, 1]) {
      const p = alongZ ? new THREE.Vector3(0, Y_OVERLAY * 2, k ? z1 + 0.05 : z0 - 0.2)
        : new THREE.Vector3(k ? x1 + 0.05 : x0 - 0.2, Y_OVERLAY * 2, (z0 + z1) / 2);
      const a = new THREE.ArrowHelper(alongZ ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0), p, 0.15, 0xffb347, 0.05, 0.035);
      a.renderOrder = 20_004;
      this.overlay.add(a);
      this.arrows.push(a);
    }
  }

  /** Dipole arrows at the gap mid-planes (and in the covers), aligned by the local field. */
  private buildDipoles(): void {
    const m = this.meta!, g = this.grid!, s = this.sol!;
    const zs: number[] = [];
    const plates = [...m.plates].sort((a, b) => a.z[0] - b.z[0]);
    for (let i = 0; i < plates.length - 1; i++) zs.push((plates[i].z[1] + plates[i + 1].z[0]) / 2);
    if (plates[0].z[0] - m.domain[0][1] > 0.02) zs.push((m.domain[0][1] + plates[0].z[0]) / 2);
    if (m.domain[1][1] - plates[plates.length - 1].z[1] > 0.02) zs.push((plates[plates.length - 1].z[1] + m.domain[1][1]) / 2);
    const [[x0], [x1]] = m.domain;
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    this.dipoleData = [];
    for (const z of zs) for (let x = x0 + 0.03; x < x1 - 0.02; x += 0.045) {
      const ex = sample(g, s.jx, x, z), ez = sample(g, s.jy, x, z);
      const mag = Math.hypot(ex, ez);
      this.dipoleData.push({ x, z, ex: mag ? ex / mag : 0, ez: mag ? ez / mag : 1,
        s: Math.min(1, mag / this.eRef), a0: rnd() * Math.PI * 2 });
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.dipoleData.length * 18), 3));
    this.dipoles = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      color: 0xffe9a8, transparent: true, opacity: 0.9, depthWrite: false,
    }));
    this.dipoles.renderOrder = 20_002;
    this.overlay.add(this.dipoles);
    this.updateDipoles();
  }

  private updateDipoles(): void {
    if (!this.dipoles) return;
    const L = Math.min(0.02, (this.meta!.overlap.gap) * 0.75) * this.dipScale;
    const pos = this.dipoles.geometry.getAttribute("position") as THREE.BufferAttribute;
    let i = 0;
    for (const d of this.dipoleData) {
      // rotate from a random orientation towards the field, more strongly where |E| is large
      const k = this.align * Math.min(1, d.s * 1.2);
      const ta = Math.atan2(d.ez * this.dipSign, d.ex * this.dipSign);
      let da = ta - d.a0;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      const a = d.a0 + da * k;
      const ux = Math.cos(a), uz = Math.sin(a);
      const ax = d.x - ux * L / 2, az = d.z - uz * L / 2, bx = d.x + ux * L / 2, bz = d.z + uz * L / 2;
      const hx = -ux * L * 0.35, hz = -uz * L * 0.35, px = -uz * L * 0.22, pz = ux * L * 0.22;
      const y = Y_OVERLAY * 1.15;
      const v = [ax, y, az, bx, y, bz, bx, y, bz, bx + hx + px, y, bz + hz + pz, bx, y, bz, bx + hx - px, y, bz + hz - pz];
      for (let c = 0; c < 18; c += 3) pos.setXYZ(i++, v[c], v[c + 1], v[c + 2]);
    }
    pos.needsUpdate = true;
  }

  private detach(): void {
    this.overlay.removeFromParent();
    this.clearOverlay();
    if (this.redesignQueued !== null) cancelAnimationFrame(this.redesignQueued);
    this.redesignQueued = null;
    this.seq = null;
    this.meta = this.base = null;
    this.sol = null;
  }

  private clearOverlay(): void {
    for (const o of [...this.overlay.children]) {
      o.removeFromParent();
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose();
      (mesh.material as THREE.Material)?.dispose();
    }
    this.fieldLines = this.dipoles = null;
    this.charges = [];
    this.arrows = [];
  }

  // ------------------------------------------------------------------ state
  private applyState(): void {
    if (!this.meta) return;
    const s = this.state, U = this.U;
    U.uOn.value = s.on ? 1 : 0;
    U.uShowPot.value = s.potential ? 1 : 0;
    U.uShowLines.value = s.lines ? 1 : 0;
    if (!this.seq) {
      U.uVolt.value = 1;
      U.uField.value = 1;
      U.uHeatMix.value = s.strength || (s.ac && s.displacement) ? 1 : 0;
      this.align = 1;
      this.chargeLevel = 1;
    }
    this.overlay.visible = s.on;
    for (const a of this.arrows) a.visible = s.ac;
    if (s.ac) {
      if (s.paused) this.theta = (s.phaseDeg * Math.PI) / 180;
      this.acFrame();
    } else {
      const k = this.designScale();
      U.uAcScale.value = 1;
      U.uHeatGain.value = 0.62 * k.kE;
      this.dipSign = 1;
      this.dipScale = THREE.MathUtils.clamp(Math.sqrt(k.kP), 0.35, 1.8);
    }
    this.updateOverlayVisibility();
    this.updateDipoles();
    this.viewer.invalidate();
    this.onChange();
  }

  private updateOverlayVisibility(): void {
    const s = this.state;
    const fieldIn = this.seq ? smooth((this.seq.t - 2.0) / 2.0) : 1;
    if (this.fieldLines) {
      this.fieldLines.visible = s.fieldLines;
      const acK = s.ac ? Math.abs(s.displacement ? Math.cos(this.theta) : Math.sin(this.theta)) : 1;
      (this.fieldLines.material as THREE.LineBasicMaterial).opacity = 0.55 * fieldIn * (0.15 + 0.85 * acK);
    }
    const v = s.ac ? Math.sin(this.theta) : 1;               // + side potential / V0
    for (const c of this.charges) {
      c.pts.visible = s.charges;
      // + plates show + when v > 0; - plates show - when v > 0; both swap when v < 0
      const amount = c.plus === c.platesPositive ? Math.max(0, v) : Math.max(0, -v);
      const mat = c.pts.material as THREE.PointsMaterial;
      mat.opacity = this.chargeLevel * amount;
      mat.size = 9 * THREE.MathUtils.clamp(Math.sqrt(this.designScale().kSigma), 0.6, 2.2);   // σ = ε E
    }
    if (this.dipoles) {
      this.dipoles.visible = s.dipoles;
      (this.dipoles.material as THREE.LineBasicMaterial).opacity = 0.9 * (this.seq ? smooth((this.seq.t - 3.2) / 0.8) : 1);
    }
  }

  /** Apply the instantaneous AC state (quasi-static: field = V(t) x solved DC field). */
  private acFrame(): void {
    const U = this.U, s = this.state;
    const v = Math.sin(this.theta), c = Math.cos(this.theta);
    U.uAcScale.value = v;
    U.uHeatMix.value = s.strength || s.displacement ? 1 : 0;
    // |E| follows |V|; displacement current eps dE/dt follows |dV/dt| (90 degrees ahead)
    U.uHeatGain.value = 0.62 * this.designScale().kE * Math.abs(s.displacement ? c : v);
    this.dipSign = v >= 0 ? 1 : -1;
    this.dipScale = 0.25 + 0.75 * Math.abs(v);               // polarisation P = eps0 (eps_r - 1) E
    for (const [i, a] of this.arrows.entries()) {
      // current flows into the + terminal while V rises, out of it while V falls
      const len = 0.03 + 0.14 * Math.abs(c);
      const alongZ = this.meta!.arrow_axis === "z", sgn = c >= 0 ? 1 : -1;
      a.setDirection(alongZ ? new THREE.Vector3(0, 0, sgn) : new THREE.Vector3(sgn, 0, 0));
      a.setLength(len, 0.05 * Math.min(1, len / 0.08), 0.035);
      const [[x0, z0], [x1, z1]] = this.meta!.domain;
      const lo = alongZ ? z0 : x0, hi = alongZ ? z1 : x1;
      const pos = i === 0 ? (c >= 0 ? lo - 0.05 - len : lo - 0.05) : (c >= 0 ? hi + 0.05 : hi + 0.05 + len);
      if (alongZ) a.position.z = pos; else a.position.x = pos;
    }
    this.updateDipoles();
  }

  readoutAc(): AcReadout | null {
    const m = this.meta;
    if (!m) return null;
    const e = m.electrical, ac = e.ac;
    const f = 10 ** this.state.freqLog, w = 2 * Math.PI * f;
    const C = e.real_part.capacitance_f, V0 = this.state.acAmp;
    const Xc = 1 / (w * C), X = w * ac.esl_h - Xc;
    const Z = Math.hypot(ac.esr_ohm, X);
    const phaseDeg = (Math.atan2(X, ac.esr_ohm) * 180) / Math.PI;     // < 0: capacitive (current leads)
    // RC-style filter: V_out / V_in = Z_cap / (R_s + Z_cap)
    const rs = ac.filter_source_ohm;
    const atten = Z / Math.hypot(rs + ac.esr_ohm, X);
    const Ereal = V0 / (e.real_part.dielectric_um * 1e-6);            // V/m
    const s = Math.sin(this.theta), c = Math.cos(this.theta);
    const caption = Math.abs(s) > 0.92
      ? "Voltage at its peak: field and polarisation are maximal but momentarily not changing, so the displacement current is ~0."
      : Math.abs(c) > 0.92
        ? "Voltage crossing zero: the field is changing fastest, so the displacement current (and the current in the terminations) peaks."
        : "Current leads voltage by 90°: charge flows in while V rises and back out while it falls; the dipoles follow the field.";
    return {
      f, V0, C, Xc, Z, phaseDeg, srf: 1 / (2 * Math.PI * Math.sqrt(ac.esl_h * C)), esr: ac.esr_ohm, esl: ac.esl_h,
      Iamp: V0 / Z, atten, rs, Jd: EPS0 * e.epsilon_r * w * Ereal, polarFrac: (e.epsilon_r - 1) / e.epsilon_r,
      s, c, theta: this.theta, caption,
    };
  }

  setAc(on: boolean): void {
    this.state.ac = on;
    this.seq = null;
    if (on) this.state.strength = false;
    this.applyState();
  }

  private tick(dt: number): boolean {
    if (!this.meta || !this.state.on) return false;
    if (this.state.ac && !this.seq) {
      if (!this.state.paused) {
        this.theta = (this.theta + 2 * Math.PI * AC_VIS_HZ * dt) % (2 * Math.PI);
        this.state.phaseDeg = Math.round((this.theta * 180) / Math.PI);
      }
      this.acFrame();
      this.updateOverlayVisibility();
      this.onChange();
      return !this.state.paused;
    }
    if (!this.seq) return false;
    const t = (this.seq.t += dt);
    const p = (key: string) => {
      const st = STAGES.find((x) => x.key === key)!;
      return smooth((t - st.start) / (st.end - st.start));
    };
    const U = this.U;
    U.uVolt.value = p("volt");
    U.uField.value = p("field");
    U.uHeatMix.value = p("fringe");
    this.chargeLevel = t < 1 ? 0 : 1 - Math.exp(-(t - 1) / TAU);
    this.align = p("polar");
    this.updateDipoles();
    this.updateOverlayVisibility();
    if (t > STAGES[STAGES.length - 1].end + 0.3) {
      this.seq = null;
      this.state.strength = true;
      this.applyState();
    }
    this.onChange();
    return true;
  }

  /** For tests. */
  diagnostics() {
    const r = this.readout()!;
    return { flux: this.flux(), iIn: this.sol!.iIn, iOut: this.sol!.iOut, C: r.C, Cideal: r.Cideal,
      midGapV: this.midGapPotential() };
  }

  /** Potential halfway between the two middle plates (should be ~0.5). */
  private midGapPotential(): number {
    const m = this.meta!, pl = [...m.plates].sort((a, b) => a.z[0] - b.z[0]);
    const i = Math.floor(pl.length / 2) - 1;
    return sample(this.grid!, this.sol!.V, 0, (pl[i].z[1] + pl[i + 1].z[0]) / 2);
  }
}

function smooth(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

const glyphCache = new Map<string, THREE.Texture>();
function glyph(ch: string, color: string): THREE.Texture {
  const key = ch + color;
  const hit = glyphCache.get(key);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d")!;
  g.fillStyle = color;
  g.beginPath();
  g.arc(16, 16, 13, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = "#ffffff";
  g.lineWidth = 4;
  g.beginPath();
  g.moveTo(9, 16); g.lineTo(23, 16);
  if (ch === "+") { g.moveTo(16, 9); g.lineTo(16, 23); }
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  glyphCache.set(key, t);
  return t;
}
