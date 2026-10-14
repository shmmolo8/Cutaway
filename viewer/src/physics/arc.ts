import * as THREE from "three";
import type GUI from "lil-gui";
import { fmt } from "../format";
import type { ComponentModel } from "../model";
import type { RotaryTrackMeta } from "../types";
import { FilmPhysics, type FilmReadout, type FilmState, type Stage } from "./film";
import { injectPhysics, ROLE } from "./shading";
import { FILM, FIXV, HIGH, INSUL, LOW, makeGrid, sample, solveLadder, type Grid, type Solution } from "./solver";

export interface ArcState extends FilmState {
  turns: number;                // adjustment screw position, 0 ... turns.total
  loaded: boolean;              // a load resistor from the wiper (pin 2) to pin 3
  loadLog: number;              // log10 of the load resistance (ohm)
}

export interface ArcReadout extends FilmReadout {
  Vout: number; Vunloaded: number; Iwiper: number; Iout: number;
  R1: number; R2: number; RL: number; frac: number; turns: number;
}

/**
 * Trimmer potentiometer (metadata `physics.type = "rotary_track"`): sheet conduction on an arc
 * of cermet, pin 1 driven, pin 3 grounded. The wiper is a tap: unloaded it only samples the
 * solved potential; with a load it is a contact at the potential v where the current it draws
 * from the track equals v·V / R_load. The problem is linear in v, so two probe solves give v
 * exactly and a third solves the loaded field. The screw-turn slider turns the drawn rotor,
 * wiper and screw (vertex rewrite about the metadata axes; section stencils share the buffers).
 */
export class ArcPhysics extends FilmPhysics<RotaryTrackMeta, ArcState> {
  readonly state: ArcState = {
    on: false, voltage: 0, potential: true, lines: true, current: true, heat: false, electrons: false,
    turns: 0, loaded: false, loadLog: 4,
  };
  protected readonly type = "rotary_track";
  protected readonly stages: readonly Stage[] = [
    { key: "volt", start: 0.0, end: 1.0, caption: "1 · Voltage applied to pin 1; pin 3 is grounded" },
    { key: "field", start: 1.0, end: 2.5, caption: "2 · The voltage falls steadily along the cermet arc: equipotentials are spokes" },
    { key: "flow", start: 2.5, end: 4.5, caption: "3 · Current follows the arc, denser on the inside edge (J ∝ 1/r, the shorter path)" },
    { key: "heat", start: 4.5, end: 6.3, caption: "4 · The wiper taps the arc: pin 2 sits at the voltage of the point it touches" },
    { key: "spread", start: 6.3, end: 8.0, caption: "5 · Heat from the track spreads into the alumina (illustrative)" },
  ];
  protected mapping = "xz" as const;
  protected nx = 140;
  protected dragNx = 80;
  private rSheet = 1;
  private vTap = 0.5;                                 // wiper potential (0..1) of the last solve
  private origPos = new Map<string, Float32Array>();

  attach(model: ComponentModel): boolean {
    this.origPos.clear();
    if (!super.attach(model)) return false;
    // the wiper, collector ring and pin 2 show the wiper potential
    for (const id of this.meta!.contacts.wiper) {
      const l = model.byId.get(id);
      if (!l) continue;
      injectPhysics(l.material, ROLE.TAP, this.U, this.mapping);
      const cap = this.section.capMaterial(id);
      if (cap) injectPhysics(cap, ROLE.TAP, this.U, this.mapping);
    }
    this.turnRotor();
    return true;
  }

  protected setupMapping(m: RotaryTrackMeta): void {
    this.U.uZFilm.value = m.film_y;
    this.U.uLambda.value = 0.35;
  }

  protected calibrate(m: RotaryTrackMeta): void {
    this.state.turns = m.turns.built;
    this.rSheet = m.electrical.nominal_ohm / solveLadder(this.arcBuilder(false, 0), this.nx).sol.r;
    this.qRef = 0;
  }

  protected sheetOhm(): number {
    return this.rSheet;
  }

  /** Wiper angle (deg) for the current screw position: 0 turns = pin 3 end, all = pin 1 end. */
  private wiperDeg(turns = this.state.turns): number {
    const t = this.meta!.track;
    return t.to_deg - ((t.to_deg - t.from_deg) * turns) / this.meta!.turns.total;
  }

  protected builder() {
    return this.arcBuilder(this.state.loaded, this.vTap);
  }

  /** Track arc (FILM), pad sectors beyond each end (pin 1 HIGH, pin 3 LOW), optional wiper tap. */
  private arcBuilder(tap: boolean, v: number) {
    const m = this.meta!, t = m.track, [cx, cz] = m.center, [ri, ro] = t.r;
    const [[x0, z0], [x1, z1]] = m.domain;
    const th = (this.wiperDeg() * Math.PI) / 180;
    const ux = Math.cos(th), uz = Math.sin(th);
    return (nx: number) => {
      const g = makeGrid(x0, z0, x1, z1, nx);
      g.type.fill(INSUL);
      if (tap) g.fixed = new Float32Array(g.nx * g.ny).fill(v);
      for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
        const dx = g.x0 + (i + 0.5) * g.dx - cx, dz = g.y0 + (j + 0.5) * g.dy - cz;
        const r = Math.hypot(dx, dz);
        if (r < ri || r > ro) continue;
        let a = (Math.atan2(dz, dx) * 180) / Math.PI;
        if (a < t.from_deg - t.pad_deg - 1) a += 360;
        const k = j * g.nx + i;
        if (a >= t.from_deg && a <= t.to_deg) {
          g.type[k] = FILM;
          // the wiper bar: within its half-width of the wiper's radial line, on the far side of the axis excluded
          if (tap && Math.abs(-dx * uz + dz * ux) <= m.wiper.half_width && dx * ux + dz * uz > 0) g.type[k] = FIXV;
        } else if (a >= t.from_deg - t.pad_deg && a < t.from_deg) g.type[k] = HIGH;
        else if (a > t.to_deg && a <= t.to_deg + t.pad_deg) g.type[k] = LOW;
      }
      return g;
    };
  }

  /** Loaded wiper: the tap current is linear in its potential v, so probe v = 0 and v = 1. */
  protected solveField(nx: number, warm?: Float32Array): { grid: Grid; sol: Solution } {
    if (!this.state.loaded) {
      const res = solveLadder(this.arcBuilder(false, 0), nx, warm);
      const th = (this.wiperDeg() * Math.PI) / 180, m = this.meta!;
      this.vTap = sample(res.grid, res.sol.V, m.center[0] + m.wiper.r * Math.cos(th), m.center[1] + m.wiper.r * Math.sin(th));
      this.U.uTapV.value = this.vTap;                    // wiper / collector / pin 2 colour
      return res;
    }
    const a = solveLadder(this.arcBuilder(true, 0), nx, warm);
    const b = solveLadder(this.arcBuilder(true, 1), nx, a.sol.V);
    const k = this.rSheet / 10 ** this.state.loadLog;           // tap current (sheet units) per volt of v
    const i0 = a.sol.iFix, slope = b.sol.iFix - a.sol.iFix;     // iFix(v) = i0 + slope v
    this.vTap = Math.min(1, Math.max(0, i0 / (k - slope)));
    this.U.uTapV.value = this.vTap;
    return solveLadder(this.arcBuilder(true, this.vTap), nx, b.sol.V);
  }

  setTurns(turns: number): void {
    this.state.turns = turns;
    this.turnRotor();
    this.queueSolve();
  }

  setLoad(p: Partial<Pick<ArcState, "loaded" | "loadLog">>): void {
    Object.assign(this.state, p);
    this.queueSolve();
  }

  /** Turn the drawn rotor/wiper about the track axis and the screw about its own axis. */
  private turnRotor(): void {
    const m = this.meta, model = this.model;
    if (!m || !model) return;
    const dTurns = this.state.turns - m.turns.built;
    for (const rot of m.rotate) {
      const a = (rot.deg_per_turn * dTurns * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
      // in-plane axes: "xz" turns +x towards +z about y; "xy" turns +x towards +y about z
      const [p, q] = rot.plane === "xz" ? [0, 2] : [0, 1];
      for (const id of rot.ids) {
        const l = model.byId.get(id);
        if (!l) continue;
        const attr = l.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
        const nAttr = l.mesh.geometry.getAttribute("normal") as THREE.BufferAttribute | undefined;
        if (!this.origPos.has(id)) {
          this.origPos.set(id, Float32Array.from(attr.array as Float32Array));
          if (nAttr) this.origPos.set(`${id}#n`, Float32Array.from(nAttr.array as Float32Array));
        }
        const o = this.origPos.get(id)!, pos = attr.array as Float32Array;
        for (let i = 0; i < o.length; i += 3) {
          const u = o[i + p] - rot.center[p], v = o[i + q] - rot.center[q];
          pos[i + p] = rot.center[p] + u * c - v * s;
          pos[i + q] = rot.center[q] + u * s + v * c;
        }
        attr.needsUpdate = true;
        if (nAttr) {
          const on = this.origPos.get(`${id}#n`)!, nn = nAttr.array as Float32Array;
          for (let i = 0; i < on.length; i += 3) {
            nn[i + p] = on[i + p] * c - on[i + q] * s;
            nn[i + q] = on[i + p] * s + on[i + q] * c;
          }
          nAttr.needsUpdate = true;
        }
        l.mesh.geometry.computeBoundingBox();
        l.mesh.geometry.computeBoundingSphere();
      }
    }
    this.viewer.invalidate();
  }

  readout(): ArcReadout | null {
    const base = super.readout();
    const m = this.meta;
    if (!base || !m || !this.sol) return null;
    const V = this.state.voltage, R = m.electrical.nominal_ohm, t = m.track;
    const frac = (this.wiperDeg() - t.to_deg) / (t.from_deg - t.to_deg);   // share of the track below the wiper
    const scale = V / this.rSheet;                                         // sheet units -> amps
    const Iin = this.sol.iIn * scale, Iw = this.state.loaded ? this.sol.iFix * scale : 0;
    return {
      ...base, R, I: Iin, P: V * Iin, Vout: this.vTap * V, Vunloaded: frac * V, Iwiper: Iw, Iout: this.sol.iOut * scale,
      R1: (1 - frac) * R, R2: frac * R, RL: 10 ** this.state.loadLog, frac, turns: this.state.turns,
    };
  }

  protected applyState(): void {
    this.U.uTapV.value = this.vTap;
    super.applyState();
  }

  // ------------------------------------------------------------------ scene
  /** Arc of the track just in front of it (the pads are metal, shaded as contacts). */
  protected buildSkin(m: RotaryTrackMeta, model: ComponentModel): THREE.Mesh {
    const t = m.track, [cx, cz] = m.center, y = m.film_y - 0.0005, seg = 120;
    const pos: number[] = [], nor: number[] = [], idx: number[] = [];
    for (let k = 0; k <= seg; k++) {
      const a = ((t.from_deg + ((t.to_deg - t.from_deg) * k) / seg) * Math.PI) / 180;
      for (const r of t.r) { pos.push(cx + r * Math.cos(a), y, cz + r * Math.sin(a)); nor.push(0, -1, 0); }
      if (k < seg) { const b = 2 * k; idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
    geo.setIndex(idx);
    const mat = this.skinMaterial(model);
    mat.side = THREE.DoubleSide;
    return new THREE.Mesh(geo, mat);
  }

  protected particlePos(x: number, y: number, out: THREE.Vector3): void {
    out.set(x, this.meta!.film_y - 0.004, y);
  }

  // ------------------------------------------------------------------ GUI + readout
  buildGui(f: GUI, powerOn: (play: boolean) => void): void {
    const s = this.state, m = this.meta!, e = m.electrical;
    f.add({ play: () => powerOn(true) }, "play").name("▶ Power on (animated)");
    f.add(s, "on").name("Powered").onChange((v: boolean) => (v ? powerOn(false) : this.setOn(false)));
    f.add(s, "voltage", 0.5, e.max_working_voltage_v, 0.5).name("Voltage on pin 1 (V)").onChange((v: number) => this.set("voltage", v));
    f.add(s, "turns", 0, m.turns.total, 0.05).name("Screw turns (wiper)").onChange((v: number) => this.setTurns(v));
    f.add(s, "loaded").name("Load on the wiper").onChange((v: boolean) => this.setLoad({ loaded: v }));
    const load = f.add(s, "loadLog", 1, 6, 0.01).name("Load resistance").onChange((v: number) => { this.setLoad({ loadLog: v }); upd(); });
    const label = document.createElement("span");
    label.className = "freq-label";
    load.$widget.append(label);
    const upd = () => { label.textContent = fmt(10 ** s.loadLog, "Ω"); };
    upd();
    f.add(s, "potential").name("Potential (red → black)").onChange((v: boolean) => this.set("potential", v));
    f.add(s, "lines").name("Equipotential lines").onChange((v: boolean) => this.set("lines", v));
    f.add(s, "current").name("Current flow").onChange((v: boolean) => this.set("current", v));
    f.add(s, "heat").name("Heat (J²/σ)").onChange((v: boolean) => this.set("heat", v));
    f.add(s, "electrons").name("Show electron drift").onChange((v: boolean) => this.set("electrons", v));
  }

  hudHtml(): string | null {
    const r = this.readout(), s = this.state, m = this.meta;
    if (!r || !m || !s.on) return null;
    const pct = (100 * r.P) / r.rated;
    const drop = r.Vunloaded > 0 ? (100 * (r.Vunloaded - r.Vout)) / r.Vunloaded : 0;
    const loadNote = s.loaded
      ? `Loaded by ${fmt(r.RL, "Ω")}: ${fmt(r.Iwiper, "A")} leaves through the wiper, so the part of the track above it carries more
         current than the part below (${fmt(r.I, "A")} vs ${fmt(r.Iout, "A")}). V<sub>out</sub> sags ${drop.toFixed(1)}% below the unloaded
         ${fmt(r.Vunloaded, "V")} — keep R<sub>load</sub> ≫ R for a stiff divider.`
      : `No load: the wiper draws no current and simply reads the track voltage where it touches.`;
    return `<div class="col">
      <div class="nums">
        <div><span>Voltage (pin 1)</span><b>${fmt(r.V, "V")}</b></div>
        <div><span>Wiper (pin 2)</span><b>${fmt(r.Vout, "V")}</b></div>
        <div><span>Current in</span><b>${fmt(r.I, "A")}</b></div>
        <div class="${pct > 100 ? "over" : ""}"><span>Power (${pct.toFixed(0)}% of ${fmt(r.rated, "W")})</span><b>${fmt(r.P, "W")}</b></div>
      </div>
      ${r.stage ? `<div class="stage">${r.stage}</div>` : ""}</div>
      <div class="col details">
      <div class="note">Screw at ${r.turns.toFixed(1)} of ${m.turns.total} turns: the wiper sits ${(100 * r.frac).toFixed(0)}% of the way from pin 3,
        splitting ${fmt(r.R, "Ω")} into R<sub>1-2</sub> = ${fmt(r.R1, "Ω")} and R<sub>2-3</sub> = ${fmt(r.R2, "Ω")}:
        V<sub>out</sub> = V·R<sub>2-3</sub>/R = ${fmt(r.Vunloaded, "V")} unloaded.</div>
      <div class="note">${loadNote}</div>
      </div><div class="col">
      ${s.heat ? `<div class="legend">cool<div class="bar" style="background:linear-gradient(90deg,#1a0c08,#8a1400,#ff6a00,#ffd23f,#fffbe6)"></div>hot</div>` : `<div class="legend">0 V<div class="bar" style="background:linear-gradient(90deg,#0b0b0c,#e0302a)"></div>+V</div>`}
      <div class="note">Track potential, current and heat are solved on the arc (∇·σ∇V = 0), the loaded wiper as a contact
        whose current matches the load. The worm gives ${m.turns.total} screw turns end to end. Heat in the alumina is illustrative.</div>
      </div>`;
  }

  /** For tests: wiper potential fraction and currents for a screw position / load, solved from scratch. */
  probe(turns: number, loadOhm: number | null) {
    const saved = { turns: this.state.turns, loaded: this.state.loaded, loadLog: this.state.loadLog, v: this.vTap };
    Object.assign(this.state, { turns, loaded: loadOhm !== null, loadLog: loadOhm ? Math.log10(loadOhm) : saved.loadLog });
    const { sol } = this.solveField(this.nx);
    const out = { v: this.vTap, iIn: sol.iIn, iOut: sol.iOut, iFix: sol.iFix, rSheet: this.rSheet };
    Object.assign(this.state, { turns: saved.turns, loaded: saved.loaded, loadLog: saved.loadLog });
    this.vTap = saved.v;
    return out;
  }
}
