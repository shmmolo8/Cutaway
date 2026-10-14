import * as THREE from "three";
import type GUI from "lil-gui";
import { fmt } from "../format";
import type { ComponentModel } from "../model";
import type { HelixPhysicsMeta } from "../types";
import { FilmPhysics, type FilmReadout, type FilmState, type Stage } from "./film";
import { fillRect, HIGH, LOW, makeGrid, solveLadder } from "./solver";
import { fillSpiral, trackGeometry } from "./spiral";

export interface HelixState extends FilmState {
  thicknessNm: number;          // carbon film thickness
  turns: number;                // spiral turns cut (track length)
  width: number;                // axial track width, mm (groove pitch - kerf)
}

export interface HelixReadout extends FilmReadout {
  rSheet: number;               // ohm per square = rho / t
  squares: number;              // solved R / R_sheet
  length: number; widthAcross: number; thicknessNm: number; turns: number; pitch: number;
  rFormula: number;             // rho * length / (width * t) (+ the uncut rings at the ends)
  rUncut: number;               // the same film without any spiral
  inTolerance: boolean;
}

/**
 * Carbon film on a ceramic rod with a helical groove (metadata `physics.type =
 * "helical_film"`). The film is solved unrolled, wrapping around the rod. Unlike the chip
 * resistor nothing is calibrated: R = (rho / t) * squares, with a typical carbon
 * resistivity, the film thickness and the solved number of squares of the spiral track.
 */
export class HelixPhysics extends FilmPhysics<HelixPhysicsMeta, HelixState> {
  readonly state: HelixState = {
    on: false, voltage: 0, potential: true, lines: true, current: true, heat: false, electrons: false,
    thicknessNm: 300, turns: 0, width: 0.2,
  };
  protected readonly type = "helical_film";
  protected readonly stages: readonly Stage[] = [
    { key: "volt", start: 0.0, end: 1.0, caption: "1 · Voltage applied: the caps and leads jump to + and 0 V" },
    { key: "field", start: 1.0, end: 2.5, caption: "2 · The field forms: the whole voltage drop happens along the thin carbon film" },
    { key: "flow", start: 2.5, end: 4.5, caption: "3 · Current flows: the groove forces it round and round the rod along the spiral track" },
    { key: "heat", start: 4.5, end: 6.3, caption: "4 · Heating: power J²/σ spreads along the whole track; the ends of the cut run hotter" },
    { key: "spread", start: 6.3, end: 8.0, caption: "5 · Heat flows into the ceramic rod and out through the caps and leads into the PCB" },
  ];
  protected mapping = "cyl" as const;
  protected nx = 96;            // along the film; the circumference gets the same cell size
  protected dragNx = 64;
  private rSheetRef = 1;        // ohm/sq of the real part (heat colour reference)
  private defaults: Pick<HelixState, "thicknessNm" | "turns" | "width"> | null = null;
  private turnsCtrl: ReturnType<GUI["add"]> | null = null;

  private get circ(): number {
    return 2 * Math.PI * this.meta!.radius;
  }

  protected setupMapping(m: HelixPhysicsMeta): void {
    this.U.uCyl.value.set(m.axis.y, m.axis.z, m.radius);
    this.U.uCylX.value.set(m.axis.x_center, (m.contact_x[1] - m.contact_x[0]) / 2);
    // heat runs along the whole track (not one hot spot), so keep the illustrative spread shallow
    this.U.uLambda.value = Math.max(0.03, m.radius * 0.15);
  }

  protected calibrate(m: HelixPhysicsMeta): void {
    const sp = m.spiral;
    this.defaults = { thicknessNm: m.film.thickness_um * 1000, turns: sp.turns, width: +(sp.pitch - sp.kerf).toFixed(3) };
    Object.assign(this.state, this.defaults);
    this.rSheetRef = this.sheetOhm();
    this.qRef = 0;                           // the first solve is the real part: its heat is the scale
  }

  protected sheetOhm(): number {
    return this.meta!.electrical.resistivity_ohm_m / (this.state.thicknessNm * 1e-9);
  }

  protected heatScale(): number {
    // same voltage, lower sheet resistance -> more power per area (p = V^2 q / R_sheet)
    return this.rSheetRef / this.sheetOhm();
  }

  protected builder() {
    return this.spiralBuilder(this.state.turns, this.state.width);
  }

  private spiralBuilder(turns: number, width: number) {
    const m = this.meta!, sp = m.spiral, circ = this.circ;
    const [[x0], [x1]] = m.domain;
    const cut = { xStart: sp.x_start, pitch: width + sp.kerf, turns, kerf: sp.kerf, s0: sp.start_angle * m.radius };
    return (nx: number) => {
      const g = makeGrid(x0, 0, x1, circ, nx, undefined, true);
      g.pathLength = Math.max(1, turns) * circ;
      fillRect(g, x0, m.contact_x[0], 0, circ, HIGH);
      fillRect(g, m.contact_x[1], x1, 0, circ, LOW);
      fillSpiral(g, cut, circ);
      return g;
    };
  }

  /** Most turns that fit between the caps at a given track width. */
  maxTurns(width = this.state.width): number {
    const sp = this.meta?.spiral;
    if (!sp) return 0;
    return Math.floor((100 * (sp.x_limit - sp.x_start - sp.kerf / 2)) / (width + sp.kerf)) / 100;
  }

  setGeometry(p: Partial<Pick<HelixState, "thicknessNm" | "turns" | "width">>): void {
    Object.assign(this.state, p);
    this.state.turns = Math.min(this.state.turns, this.maxTurns());
    this.turnsCtrl?.max(this.maxTurns()).updateDisplay();
    if (p.turns !== undefined || p.width !== undefined) this.queueSolve();
    else this.applyState();                  // thickness only rescales R: no new solve
  }

  resetGeometry(): void {
    if (this.defaults) this.setGeometry({ ...this.defaults });
  }

  readout(): HelixReadout | null {
    const r = super.readout();
    const m = this.meta;
    if (!r || !m || !this.sol) return null;
    const s = this.state, sp = m.spiral, circ = this.circ, rs = this.sheetOhm();
    const pitch = s.width + sp.kerf;
    const tr = trackGeometry(s.turns, pitch, sp.kerf, circ);
    // uncut rings between each cap and the ends of the spiral add a little
    const rings = (sp.x_start - m.contact_x[0] + Math.max(0, m.contact_x[1] - (sp.x_start + s.turns * pitch))) / circ;
    const rFormula = s.turns >= 1 ? rs * (tr.length / tr.width + rings) : NaN;
    return {
      ...r, rSheet: rs, squares: this.sol.r, length: tr.length, widthAcross: tr.width, thicknessNm: s.thicknessNm,
      turns: s.turns, pitch, rFormula, rUncut: (rs * (m.contact_x[1] - m.contact_x[0])) / circ,
      inTolerance: Math.abs(r.R / m.electrical.nominal_ohm - 1) <= m.electrical.tolerance,
    };
  }

  // ------------------------------------------------------------------ scene
  /** Cylinder just outside the film between the domain ends (under the caps it is hidden). */
  protected buildSkin(m: HelixPhysicsMeta, model: ComponentModel): THREE.Mesh {
    const [[x0], [x1]] = m.domain;
    const r = m.radius + 0.0005, seg = 256;
    const pos: number[] = [], nor: number[] = [], idx: number[] = [];
    for (let k = 0; k <= seg; k++) {
      const a = (k / seg) * 2 * Math.PI, c = Math.cos(a), s = Math.sin(a);
      for (const x of [x0, x1]) {
        pos.push(x, m.axis.y + r * c, m.axis.z + r * s);
        nor.push(0, c, s);
      }
      if (k < seg) {
        const b = 2 * k;
        idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
    geo.setIndex(idx);
    return new THREE.Mesh(geo, this.skinMaterial(model));
  }

  protected particlePos(x: number, y: number, out: THREE.Vector3): void {
    const m = this.meta!, a = y / m.radius, r = m.radius + 0.004;
    out.set(x, m.axis.y + r * Math.cos(a), m.axis.z + r * Math.sin(a));
  }

  // ------------------------------------------------------------------ GUI + readout
  buildGui(f: GUI, powerOn: (play: boolean) => void): void {
    const s = this.state, e = this.meta!.electrical;
    f.add({ play: () => powerOn(true) }, "play").name("▶ Power on (animated)");
    f.add(s, "on").name("Powered").onChange((v: boolean) => (v ? powerOn(false) : this.setOn(false)));
    f.add(s, "voltage", 0.5, e.max_working_voltage_v, 0.5).name("Voltage (V)").onChange((v: number) => this.set("voltage", v));
    f.add(s, "thicknessNm", 20, 1500, 5).name("Carbon thickness t (nm)")
      .onChange((v: number) => this.setGeometry({ thicknessNm: v }));
    this.turnsCtrl = f.add(s, "turns", 0, this.maxTurns(), 0.05).name("Spiral turns (track length)")
      .onChange((v: number) => this.setGeometry({ turns: v }));
    f.add(s, "width", 0.03, 0.6, 0.005).name("Track width (mm)")
      .onChange((v: number) => this.setGeometry({ width: v }));
    f.add({ reset: () => { this.resetGeometry(); f.controllersRecursive().forEach((c) => c.updateDisplay()); } }, "reset")
      .name("↺ Back to the real part");
    f.add(s, "potential").name("Potential (red → black)").onChange((v: boolean) => this.set("potential", v));
    f.add(s, "lines").name("Equipotential lines").onChange((v: boolean) => this.set("lines", v));
    f.add(s, "current").name("Current flow").onChange((v: boolean) => this.set("current", v));
    f.add(s, "heat").name("Heat (J²/σ)").onChange((v: boolean) => this.set("heat", v));
    f.add(s, "electrons").name("Show electron drift").onChange((v: boolean) => this.set("electrons", v));
  }

  /** HUD columns (the app adds the collapse toggle), or null when off. */
  hudHtml(): string | null {
    const r = this.readout(), s = this.state, m = this.meta;
    if (!r || !m || !s.on) return null;
    const e = m.electrical;
    const pct = (100 * r.P) / r.rated;
    const dev = (100 * r.R) / e.nominal_ohm - 100;
    const formula = Number.isFinite(r.rFormula)
      ? `ρ·ℓ/(w·t) = ${fmt(r.rFormula, "Ω")} — the solver gives ${((100 * r.R) / r.rFormula - 100).toFixed(0)}% ${r.R >= r.rFormula ? "more" : "less"}
        (current crowding at the ends of the cut, and the film beyond it).`
      : `Less than one turn of cut makes no track yet: current just goes around the end of the groove.`;
    return `<div class="col">
      <div class="nums">
        <div><span>Voltage</span><b>${fmt(r.V, "V")}</b></div>
        <div><span>Current</span><b>${fmt(r.I, "A")}</b></div>
        <div class="${pct > 100 ? "over" : ""}"><span>Power (${pct.toFixed(0)}% of ${fmt(r.rated, "W")})</span><b>${fmt(r.P, "W")}</b></div>
        <div class="${r.inTolerance ? "" : "over"}"><span>Resistance (${dev >= 0 ? "+" : ""}${dev.toFixed(1)}%)</span><b>${fmt(r.R, "Ω")}</b></div>
      </div>
      ${r.stage ? `<div class="stage">${r.stage}</div>` : ""}</div>
      <div class="col details">
      <div class="note">Carbon track: length ℓ ≈ ${r.length.toFixed(1)} mm (${Math.max(0, r.turns - 1).toFixed(1)} turns around the rod),
        width w = ${r.widthAcross.toFixed(3)} mm, thickness t = ${r.thicknessNm.toFixed(0)} nm
        → R<sub>sheet</sub> = ρ/t = ${fmt(r.rSheet, "Ω")}/□, ${r.squares.toFixed(1)} squares (solved).</div>
      <div class="note">${formula}</div>
      <div class="note">Without the spiral the film is a tube ${m.film.length.toFixed(2)} mm long and πD = ${(2 * Math.PI * m.radius).toFixed(2)} mm wide:
        only ${(r.rUncut / r.rSheet).toFixed(2)} squares = ${fmt(r.rUncut, "Ω")}. ${r.inTolerance
          ? `Now within the ±${(100 * e.tolerance).toFixed(0)}% of the gold band.`
          : `Outside the ±${(100 * e.tolerance).toFixed(0)}% band: a real machine keeps cutting (or stops earlier) to land in it.`}</div>
      </div><div class="col">
      ${s.heat ? `<div class="legend">cool<div class="bar" style="background:linear-gradient(90deg,#1a0c08,#8a1400,#ff6a00,#ffd23f,#fffbe6)"></div>hot</div>` : `<div class="legend">0 V<div class="bar" style="background:linear-gradient(90deg,#0b0b0c,#e0302a)"></div>+V</div>`}
      <div class="note">Potential, current and heat are solved on the film unrolled around the rod (∇·σ∇V = 0).
        ρ = ${e.resistivity_ohm_m.toExponential(1)} Ω·m (typical pyrolytic carbon). Heat spreading into rod, caps and leads is illustrative.</div>
      </div>`;
  }

  /** For tests: resistance (ohm) for any cut, solved from scratch at full resolution. */
  resistanceFor(turns: number, width = this.state.width, thicknessNm = this.state.thicknessNm): number {
    const rs = this.meta!.electrical.resistivity_ohm_m / (thicknessNm * 1e-9);
    return rs * solveLadder(this.spiralBuilder(turns, width), this.nx).sol.r;
  }
}
