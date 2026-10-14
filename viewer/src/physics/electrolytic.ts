import * as THREE from "three";
import type GUI from "lil-gui";
import { fmt } from "../format";
import type { ComponentModel } from "../model";
import type { SectionTool } from "../section";
import type { ElectrolyticPhysicsMeta } from "../types";
import type { Viewer } from "../viewer";
import { injectPhysics, makeUniforms, ROLE, type PhysicsUniforms } from "./shading";

const EPS0 = 8.854e-12;

type Kind = "aluminum" | "tantalum";

/** Wording that differs between the two constructions (the physics is the same). */
const TEXT = {
  aluminum: {
    oxide: "Al₂O₃",
    s1: "1 · Voltage applied: anode foil +; cathode foil and the electrolyte that soaks the paper 0 V",
    s2: "2 · Charging: ions in the electrolyte crowd onto the oxide and electrons leave the anode — Q = CV piles up",
    reverse: `Reverse voltage: the oxide only blocks one way. Current surges, the electrolyte is split into gas,
      the anode oxide dissolves, and the scored vent in the can top is what opens instead of the can bursting
      (glow illustrative; most parts tolerate only ~1 V reverse).`,
    structure: "etched foil, schematic: tunnels = surface ×",
    area: (L: number, e: ElectrolyticPhysicsMeta["electrical"]) => `gain × 2 faces × ${L.toFixed(0)} mm × ${e.foil_width_mm} mm`,
    trim: (e: ElectrolyticPhysicsMeta["electrical"]) => `Foil shorter than the real ${e.ref_length_mm} mm leaves bare paper in the winding.`,
    cathode: (m: ElectrolyticPhysicsMeta) => `The electrolyte is the real cathode; the cathode foil only collects its current. The model winds ${m.model_turns} turns; a real part ~30.`,
  },
  tantalum: {
    oxide: "Ta₂O₅",
    s1: "1 · Voltage applied: tantalum pellet and wire +; MnO₂, carbon, silver and the − frame 0 V",
    s2: "2 · Charging: the MnO₂ filling every pore charges against the oxide while electrons leave the pellet — Q = CV piles up",
    reverse: `Reverse or surge voltage breaks the Ta₂O₅ down. With an MnO₂ cathode the fault current heats it until
      MnO₂ releases oxygen and the tantalum can ignite — why tantalum is derated to ~50% of rated voltage
      (glow illustrative; polymer-cathode types fail more gently).`,
    structure: "sintered pellet, schematic: particle surface ×",
    area: (L: number, e: ElectrolyticPhysicsMeta["electrical"]) =>
      `gain × the pellet's outside ${((e.ref_area_mm2 * L) / e.ref_length_mm).toFixed(1)} mm² at ${L.toFixed(2)} mm long`,
    trim: (e: ElectrolyticPhysicsMeta["electrical"]) => `A pellet shorter than the real ${e.ref_length_mm.toFixed(2)} mm holds proportionally less powder.`,
    cathode: () => `MnO₂ grown inside every pore is the real cathode; carbon and silver bring its current out. The band marks + (on an aluminium can the stripe marks −).`,
  },
} as const;

const stagesFor = (k: Kind) => [
  { key: "volt", start: 0.0, end: 1.0, caption: TEXT[k].s1 },
  { key: "charge", start: 1.0, end: 3.0, caption: TEXT[k].s2 },
  { key: "field", start: 3.0, end: 5.0, caption: `3 · The whole voltage now sits across a few tens of nanometres of ${TEXT[k].oxide}: hundreds of V/µm` },
] as const;
type Stage = ReturnType<typeof stagesFor>[number];

export interface ElectroState {
  on: boolean;
  voltage: number;              // V (negative = reverse polarity)
  strength: boolean;            // oxide coloured by field strength instead of potential
  designVf: number;             // what-if: forming voltage (V) -> oxide thickness
  designGain: number;           // what-if: etch surface gain
  designLength: number;         // what-if: anode foil length (mm)
}

export interface ElectroReadout {
  V: number; C: number; Q: number; W: number; Ileak: number;
  dNm: number; eVum: number; eRatio: number; gain: number; areaMm2: number; cFlat: number;
  Cdesign: number; dDesignNm: number; ratedDesign: number;
  reverse: boolean; over: boolean; stage: string | null;
}

/**
 * Aluminium electrolytic capacitor (metadata `physics.type = "electrolytic"`). Computed,
 * not solved: the dielectric is anodic Al2O3 a few tens of nm thick, so the field is the
 * parallel-plate V/d everywhere. C = eps0 eps_r (gain x 2 L W) / d; the etch gain is the
 * one implied by the marked capacitance.
 */
export class ElectroPhysics {
  readonly U: PhysicsUniforms = makeUniforms();
  readonly state: ElectroState = { on: false, voltage: 0, strength: true, designVf: 0, designGain: 0, designLength: 0 };
  meta: ElectrolyticPhysicsMeta | null = null;
  onChange: () => void = () => {};
  private viewer: Viewer;
  private section: SectionTool;
  private tex: THREE.DataTexture | null = null;
  private seq: { t: number } | null = null;
  private gain = 1;
  private kind: Kind = "aluminum";
  private stages: readonly Stage[] = stagesFor("aluminum");

  constructor(viewer: Viewer, section: SectionTool) {
    this.viewer = viewer;
    this.section = section;
    viewer.onFrame((dt) => this.tick(dt));
  }

  get available(): boolean {
    return !!this.meta;
  }

  attach(model: ComponentModel): boolean {
    const meta = model.meta.physics;
    this.meta = meta?.type === "electrolytic" ? meta : null;
    this.seq = null;
    if (!this.meta) return false;
    const m = this.meta, e = m.electrical, U = this.U;
    this.kind = e.kind ?? "aluminum";
    this.stages = stagesFor(this.kind);
    // the oxide gets one uniform value: potential mid-way, field strength 1 (scaled by uHeatGain)
    if (!this.tex) {
      const h = THREE.DataUtils.toHalfFloat;
      this.tex = new THREE.DataTexture(new Uint16Array([h(0.5), h(1), h(0), h(1)]), 1, 1, THREE.RGBAFormat, THREE.HalfFloatType);
      this.tex.needsUpdate = true;
    }
    U.uFieldTex.value = this.tex;
    U.uDomainMin.value.set(-1e3, -1e3);
    U.uDomainSize.value.set(2e3, 2e3);
    U.uShowLines.value = 0;
    U.uMetalHeat.value = 0;                      // foils keep + / − colours while the oxide shows |E|
    U.uHeatEmit.value = 0.3;
    model.group.updateMatrixWorld(true);
    U.uWorldToCad.value.copy(model.root.matrixWorld).invert();
    for (const l of model.layers) {
      const id = l.meta.id;
      const role = id === m.dielectric_layer ? ROLE.FILM
        : m.contacts.positive.includes(id) ? ROLE.POSITIVE
          : m.contacts.negative.includes(id) ? ROLE.NEGATIVE : 0;
      if (!role) continue;
      const cut = m.cut_layers.includes(id);            // the length slider trims these
      injectPhysics(l.material, role, U, "xy", cut);
      const cap = this.section.capMaterial(id);
      if (cap) injectPhysics(cap, role, U, "xy", cut);
    }
    U.uCutColor.value.set(model.byId.get(m.cut_color_layer)?.meta.color ?? "#b58c5a");
    U.uCutAxis.value.set(...(m.cut.mode === "axis" ? m.cut.axis ?? [1, 0] : [0, 0]) as [number, number]);
    // etch gain implied by the marked capacitance
    this.gain = e.capacitance_f / this.flatC(e.forming_voltage_v, e.ref_length_mm);
    Object.assign(this.state, { voltage: this.state.voltage || e.rated_voltage_v, designVf: e.forming_voltage_v,
      designGain: +this.gain.toFixed(1), designLength: e.ref_length_mm });
    this.applyState();
    return true;
  }

  /** C of the smooth (un-etched) foil, both faces, for a forming voltage and foil length. */
  private flatC(vf: number, lengthMm: number): number {
    const e = this.meta!.electrical;
    return (EPS0 * e.epsilon_r * e.ref_area_mm2 * (lengthMm / e.ref_length_mm) * 1e-6) / (e.nm_per_volt * vf * 1e-9);
  }

  setOn(on: boolean): void {
    this.state.on = on;
    if (!on) this.seq = null;
    this.applyState();
  }

  play(instant = false): void {
    if (!this.meta) return;
    this.state.on = true;
    this.seq = instant ? null : { t: 0 };
    this.applyState();
  }

  set<K extends keyof ElectroState>(key: K, value: ElectroState[K]): void {
    this.state[key] = value;
    this.applyState();
  }

  readout(): ElectroReadout | null {
    const m = this.meta;
    if (!m) return null;
    const e = m.electrical, s = this.state, V = s.voltage;
    const C = e.capacitance_f;
    const t = this.seq?.t ?? null;
    return {
      V, C, Q: C * V, W: 0.5 * C * V * V, Ileak: e.leakage_cv * C * Math.abs(V),
      dNm: e.nm_per_volt * s.designVf, eVum: Math.abs(V) / (e.nm_per_volt * s.designVf * 1e-3),
      eRatio: Math.abs(V) / s.designVf, gain: this.gain,
      areaMm2: e.ref_area_mm2, cFlat: this.flatC(e.forming_voltage_v, e.ref_length_mm),
      Cdesign: this.flatC(s.designVf, s.designLength) * s.designGain, dDesignNm: e.nm_per_volt * s.designVf,
      ratedDesign: s.designVf / (e.forming_voltage_v / e.rated_voltage_v),
      reverse: V < -1, over: V > s.designVf,
      stage: t !== null ? this.stages.find((st) => t < st.end)?.caption ?? null : null,
    };
  }

  /** Re-apply sliders and state to the view (public: the design sliders call it). */
  applyState(): void {
    const m = this.meta;
    if (!m) return;
    const s = this.state, U = this.U, r = this.readout()!;
    U.uOn.value = s.on ? 1 : 0;
    // length slider: a winding keeps the share of its area (∝ r² - r_in²) out to a radius;
    // a pellet keeps the share of its length along the axis
    const c = m.cut, f = Math.min(1, s.designLength / m.electrical.ref_length_mm);
    const lim = c.mode === "radial" ? Math.sqrt(c.r_in ** 2 + f * (c.r_out ** 2 - c.r_in ** 2)) : c.r_in + f * (c.r_out - c.r_in);
    U.uRadialCut.value.set(c.center[0], c.center[1], lim, s.on && f < 0.999 ? 1 : 0);
    U.uAcScale.value = s.voltage < 0 ? -1 : 1;                 // reverse: the anode goes negative (blue)
    if (!this.seq) { U.uVolt.value = 1; U.uField.value = 1; U.uHeatMix.value = s.strength ? 1 : 0; }
    U.uShowPot.value = 1;
    // field strength relative to the forming field; reverse bias shows as (illustrative) heating
    U.uPalette.value = r.reverse ? 0 : 1;
    U.uHeatGain.value = r.reverse ? 1.1 : 0.85 * Math.min(1.3, r.eRatio);
    U.uHeatEmit.value = r.reverse || r.over ? 1.5 : 0.3;
    this.viewer.invalidate();
    this.onChange();
  }

  private tick(dt: number): boolean {
    if (!this.meta || !this.state.on || !this.seq) return false;
    this.seq.t += dt;
    const t = this.seq.t, U = this.U;
    const p = (k: Stage["key"]) => {
      const st = this.stages.find((x) => x.key === k)!;
      return Math.min(1, Math.max(0, (t - st.start) / (st.end - st.start)));
    };
    U.uVolt.value = p("volt");
    U.uField.value = p("charge");
    U.uHeatMix.value = this.state.strength ? p("field") : 0;
    if (t > this.stages[this.stages.length - 1].end + 0.3) this.seq = null;
    this.viewer.invalidate();
    this.onChange();
    return true;
  }

  // ------------------------------------------------------------------ GUI + readout
  buildGui(f: GUI, powerOn: (play: boolean) => void): void {
    const s = this.state, e = this.meta!.electrical;
    f.add({ play: () => powerOn(true) }, "play").name("▶ Charge it (animated)");
    f.add(s, "on").name("Powered").onChange((v: boolean) => (v ? powerOn(false) : this.setOn(false)));
    f.add(s, "voltage", -e.rated_voltage_v / 2, e.forming_voltage_v * 1.2, 0.1).name("Voltage (V, − = reverse)")
      .onChange((v: number) => this.set("voltage", v));
    f.add(s, "strength").name("Oxide: field strength").onChange((v: boolean) => this.set("strength", v));
    const upd = () => this.applyState();
    f.add(s, "designVf", 3, 600, 1).name("Forming voltage (V) → oxide").onChange(upd);
    const ta = e.kind === "tantalum";
    f.add(s, "designGain", 1, e.gain_max, ta ? 5 : 0.5).name(ta ? "Powder surface gain (× outside)" : "Etch gain (× area)").onChange(upd);
    f.add(s, "designLength", e.ref_length_mm * 0.1, e.ref_length_mm, e.ref_length_mm / 200)
      .name(ta ? "Pellet length (mm)" : "Anode foil length (mm)").onChange(upd);
    f.add({ reset: () => {
      Object.assign(s, { designVf: e.forming_voltage_v, designGain: +this.gain.toFixed(1), designLength: e.ref_length_mm });
      f.controllersRecursive().forEach((c) => c.updateDisplay());
      this.applyState();
    } }, "reset").name("↺ Back to the real part");
  }

  hudHtml(): string | null {
    const r = this.readout(), m = this.meta, s = this.state;
    if (!r || !m || !s.on) return null;
    const e = m.electrical, C = r.Cdesign;
    const warn = r.reverse
      ? `<div class="note over">${TEXT[this.kind].reverse}</div>`
      : r.over ? `<div class="note over">Above the ${s.designVf.toFixed(0)} V the oxide was formed at: it starts to conduct and regrow,
         with heat and gas — the margin between rated and forming voltage is the safety factor.</div>` : "";
    const real = Math.abs(C / r.C - 1) > 0.02 ? ` (real part: ${fmt(r.C, "F")}, ${e.rated_voltage_v} V)` : "";
    return `<div class="col">
      <div class="nums">
        <div><span>Voltage</span><b>${fmt(r.V, "V")}</b></div>
        <div><span>Capacitance</span><b>${fmt(C, "F")}</b></div>
        <div><span>Charge Q = CV</span><b>${fmt(Math.abs(C * r.V), "C")}</b></div>
        <div><span>Energy ½CV²</span><b>${fmt(0.5 * C * r.V * r.V, "J")}</b></div>
      </div>
      ${r.stage ? `<div class="stage">${r.stage}</div>` : ""}${warn}</div>
      <div class="col details">
      ${this.kind === "tantalum" ? this.pelletSvg(s.designGain, s.designVf) : this.foilSvg(s.designGain, s.designVf)}
      <div class="legend">${TEXT[this.kind].structure}${s.designGain.toFixed(0)}, oxide outline ∝ forming voltage</div>
      <div class="note">${TEXT[this.kind].oxide} grown at ${s.designVf.toFixed(0)} V × ${e.nm_per_volt} nm/V = <b>${r.dNm.toFixed(0)} nm</b> (εr ≈ ${e.epsilon_r}),
        rated ≈ ${r.ratedDesign.toFixed(0)} V. At ${fmt(Math.abs(r.V), "V")} it carries ${r.eVum.toFixed(0)} V/µm,
        ${(100 * r.eRatio).toFixed(0)}% of its forming field (oxide colour).</div>
      <div class="note">C = ε₀εr·(${TEXT[this.kind].area(s.designLength, e)})/d = <b>${fmt(C, "F")}</b>${real}.
        ${TEXT[this.kind].trim(e)} Thicker oxide for more
        voltage costs capacitance: C·V stays roughly constant for a given can.</div>
      </div><div class="col">
      ${s.strength ? `<div class="legend">weak<div class="bar" style="background:linear-gradient(90deg,#03030a,#1f0550,#1a5cff,#62e6ff,#f2ffff)"></div>forming field</div>` : `<div class="legend">0 V<div class="bar" style="background:linear-gradient(90deg,#0b0b0c,#e0302a)"></div>+V</div>`}
      <div class="note">Leakage ≤ ${fmt(e.leakage_cv * C * Math.abs(r.V), "A")} (0.01·C·V, datasheet-style); ESR ≈ ${fmt(e.esr_ohm, "Ω")} (typical).</div>
      <div class="note">Computed, not solved: the oxide is ~10⁵× thinner than the part, so its field is exactly V/d.
        ${TEXT[this.kind].cathode(m)}</div>
      </div>`;
  }

  /** Schematic of the sintered pellet: particle count ∝ surface gain, oxide ∝ forming V, MnO₂ between. */
  private pelletSvg(gain: number, vf: number): string {
    const W = 150, H = 46, n = Math.max(2, Math.min(14, Math.round(Math.cbrt(gain) * 1.6)));
    const r = W / n / 2.4, sw = Math.min(3, Math.max(0.3, vf / 20));
    let c = "";
    for (let j = 0; (j + 0.5) * (2 * r * 1.05) < H; j++)
      for (let i = 0; i < n; i++) {
        const x = (i + 0.5 + (j % 2) * 0.5) * (W / n), y = (j + 0.5) * 2 * r * 1.05;
        if (x < W) c += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(r * 1.12).toFixed(2)}" fill="#6e6a73" stroke="#b9a3ff" stroke-width="${sw.toFixed(2)}"/>`;
      }
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" aria-label="Sintered pellet microstructure">
      <rect x="0" y="0" width="${W}" height="${H}" fill="#2e2a26"/>${c}</svg>`;
  }

  /** Schematic cross-section of the etched anode foil: tunnel count ∝ etch gain, oxide ∝ forming V. */
  private foilSvg(gain: number, vf: number): string {
    const W = 150, n = Math.max(1, Math.min(40, Math.round(gain / 3))), sw = Math.min(4, Math.max(0.4, vf / 23));
    const depth = Math.min(9, 2 + gain / 12), step = W / n, tw = Math.min(2.2, step * 0.45);
    let tunnels = "";
    for (let i = 0; i < n; i++) {
      const x = (i + 0.5) * step - tw / 2;
      tunnels += `<rect x="${x.toFixed(2)}" y="14" width="${tw.toFixed(2)}" height="${depth.toFixed(1)}" fill="#b58c5a" stroke="#62e6ff" stroke-width="${(sw * 0.6).toFixed(2)}"/>`
        + `<rect x="${(x + step / 2).toFixed(2)}" y="${(32 - depth).toFixed(1)}" width="${tw.toFixed(2)}" height="${depth.toFixed(1)}" fill="#b58c5a" stroke="#62e6ff" stroke-width="${(sw * 0.6).toFixed(2)}"/>`;
    }
    return `<svg class="chart" viewBox="0 0 ${W} 46" width="100%" height="46" aria-label="Etched foil cross-section">
      <rect x="0" y="0" width="${W}" height="46" fill="#b58c5a" opacity="0.55"/>
      <rect x="0" y="14" width="${W}" height="18" fill="#b8bec6" stroke="#62e6ff" stroke-width="${sw.toFixed(2)}"/>
      ${tunnels}</svg>`;
  }

}
