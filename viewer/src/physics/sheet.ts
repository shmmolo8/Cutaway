import * as THREE from "three";
import type { ComponentModel } from "../model";
import type { SheetPhysicsMeta } from "../types";
import { FilmPhysics, type FilmReadout, type FilmState, type Stage } from "./film";
import { fillRect, HIGH, INSUL, LOW, makeGrid, solveLadder } from "./solver";

export interface PhysicsState extends FilmState {
  trim: number;                 // % of the modelled trim path length
}

export interface Readout extends FilmReadout {
  R0: number; trim: number;
}

/**
 * Laser-trimmed flat film (chip resistor, metadata `physics.type = "sheet_conduction"`).
 * The sheet resistance is calibrated so that the modelled trim gives the nominal value.
 */
export class SheetPhysics extends FilmPhysics<SheetPhysicsMeta, PhysicsState> {
  readonly state: PhysicsState = {
    on: false, voltage: 0, trim: 100, potential: true, lines: true, current: true, heat: false, electrons: false,
  };
  protected readonly type = "sheet_conduction";
  protected readonly stages: readonly Stage[] = [
    { key: "volt", start: 0.0, end: 1.0, caption: "1 · Voltage applied: the terminals and electrodes jump to + and 0 V" },
    { key: "field", start: 1.0, end: 2.5, caption: "2 · The field forms: the whole voltage drop happens inside the thin RuO₂ film" },
    { key: "flow", start: 2.5, end: 4.5, caption: "3 · Current flows: it must squeeze around the tip of the laser-trim cut" },
    { key: "heat", start: 4.5, end: 6.3, caption: "4 · Heating: power density J²/σ peaks at the trim tip, forming a hot spot" },
    { key: "spread", start: 6.3, end: 8.0, caption: "5 · Heat leaves through the alumina and out through the terminations into the PCB" },
  ];
  private rSheet = 1;           // ohm/sq, calibrated so the modelled trim gives the nominal value
  private r0 = 1;               // dimensionless resistance with no trim

  protected setupMapping(m: SheetPhysicsMeta): void {
    this.U.uZFilm.value = m.surface.z_low;
    this.U.uLambda.value = Math.max(0.02, (m.z_substrate[1] - m.z_substrate[0]) * 0.45);
  }

  protected calibrate(m: SheetPhysicsMeta): void {
    // modelled trim (100 %) = nominal resistance
    this.r0 = solveLadder(this.trimBuilder(0), this.nx).sol.r;
    const ref = solveLadder(this.trimBuilder(100), this.nx);
    this.rSheet = m.electrical.nominal_ohm / ref.sol.r;
    this.qRef = this.heatReference(this.trimBuilder(100));
  }

  protected sheetOhm(): number {
    return this.rSheet;
  }

  protected builder() {
    return this.trimBuilder(this.state.trim);
  }

  setTrim(pct: number): void {
    this.state.trim = pct;
    this.queueSolve();
  }

  maxTrimPct(): number {
    const m = this.meta;
    if (!m) return 100;
    const t = m.trim;
    const plunge = Math.abs(t.y_tip - t.y_film_edge);
    const leg = t.leg_end_x - (t.x0 + t.kerf / 2);
    const legMax = t.leg_end_x_max - (t.x0 + t.kerf / 2);
    return Math.floor((100 * (plunge + legMax)) / (plunge + leg));
  }

  readout(): Readout | null {
    const r = super.readout();
    return r && { ...r, R0: this.rSheet * this.r0, trim: this.state.trim };
  }

  /** Rasteriser for a given trim (% of the modelled path: plunge first, then the leg). */
  private trimBuilder(pct: number) {
    const m = this.meta!;
    const [[x0, y0], [x1, y1]] = m.domain;
    const t = m.trim;
    const plunge = Math.abs(t.y_tip - t.y_film_edge);
    const legStart = t.x0 + t.kerf / 2;
    const path = ((plunge + (t.leg_end_x - legStart)) * pct) / 100;
    return (nx: number) => {
      const g = makeGrid(x0, y0, x1, y1, nx);
      fillRect(g, x0, m.contact_x[0], y0, y1, HIGH);
      fillRect(g, m.contact_x[1], x1, y0, y1, LOW);
      if (path > 0) {
        const depth = Math.min(path, plunge);
        fillRect(g, t.x0 - t.kerf / 2, t.x0 + t.kerf / 2, t.y_film_edge + t.sy * 0.05, t.y_film_edge - t.sy * depth, INSUL);
        const leg = path - plunge;
        if (leg > 0) {
          fillRect(g, t.x0 - t.kerf / 2, legStart + leg, t.y_tip, t.y_tip + t.sy * t.kerf, INSUL);
        }
      }
      return g;
    };
  }

  /** Top surface of the film (with the step onto each electrode), untrimmed: the trim
   *  shown is whatever the solver uses, drawn by the shader's conductor mask. */
  protected buildSkin(m: SheetPhysicsMeta, model: ComponentModel): THREE.Mesh {
    const [[x0, y0], [x1, y1]] = m.domain;
    const { z_low: zl, z_high: zh, x_step: xs } = m.surface;
    const lift = 0.0004;
    const quads: number[][] = [
      [-xs, y0, zl, xs, y0, zl, xs, y1, zl, -xs, y1, zl, 0, 0, 1],
      [x0, y0, zh, -xs, y0, zh, -xs, y1, zh, x0, y1, zh, 0, 0, 1],
      [xs, y0, zh, x1, y0, zh, x1, y1, zh, xs, y1, zh, 0, 0, 1],
      [-xs, y0, zl, -xs, y1, zl, -xs, y1, zh, -xs, y0, zh, 1, 0, 0],
      [xs, y1, zl, xs, y0, zl, xs, y0, zh, xs, y1, zh, -1, 0, 0],
    ];
    const pos: number[] = [], nor: number[] = [], idx: number[] = [];
    for (const q of quads) {
      const base = pos.length / 3;
      for (let v = 0; v < 4; v++) {
        pos.push(q[3 * v] + q[12] * lift, q[3 * v + 1], q[3 * v + 2] + q[14] * lift);
        nor.push(q[12], q[13], q[14]);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
    geo.setIndex(idx);
    return new THREE.Mesh(geo, this.skinMaterial(model));
  }

  protected particlePos(x: number, y: number, out: THREE.Vector3): void {
    const zs = this.meta!.surface;
    out.set(x, y, (Math.abs(x) >= zs.x_step ? zs.z_high : zs.z_low) + 0.004);
  }

  /** For tests: resistance (ohm) for an arbitrary trim, solved from scratch. */
  resistanceAt(pct: number): number {
    return this.rSheet * solveLadder(this.trimBuilder(pct), this.nx).sol.r;
  }

  /** For tests: current conservation and exact-case error of the current solution. */
  diagnostics() {
    const m = this.meta!;
    const [[, y0], [, y1]] = m.domain;
    const exact = (m.contact_x[1] - m.contact_x[0]) / (y1 - y0);
    const c = this.conservation();
    return { iIn: c.iIn, iOut: c.iOut, r0: this.r0, r0Exact: exact, lines: c.lines };
  }
}
