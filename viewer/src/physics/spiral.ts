import { INSUL, type Grid } from "./solver";

/**
 * A helical groove on a film around a cylinder, in unrolled coordinates: x along the axis,
 * s = arc length around it (0 ... circ, periodic). The groove centre line is
 * x = xStart + pitch * u / circ for u in [0, turns * circ], with s = s0 + u (mod circ);
 * `kerf` is its width along the axis.
 */
export interface SpiralCut { xStart: number; pitch: number; turns: number; kerf: number; s0: number }

/** Mark every cell whose centre lies in the groove as insulating. */
export function fillSpiral(g: Grid, c: SpiralCut, circ: number): void {
  if (c.turns <= 0) return;
  const uMax = c.turns * circ;
  for (let j = 0; j < g.ny; j++) {
    const base = g.y0 + (j + 0.5) * g.dy - c.s0;
    for (let i = 0; i < g.nx; i++) {
      const x = g.x0 + (i + 0.5) * g.dx;
      // the pass of the centre line nearest to this cell, and its neighbours
      const n0 = Math.round(((x - c.xStart) * circ / c.pitch - base) / circ);
      for (let n = n0 - 1; n <= n0 + 1; n++) {
        const u = base + n * circ;
        if (u < 0 || u > uMax) continue;
        if (Math.abs(x - (c.xStart + (c.pitch * u) / circ)) <= c.kerf / 2) {
          g.type[j * g.nx + i] = INSUL;
          break;
        }
      }
    }
  }
}

/**
 * The conducting track the groove leaves behind, as a long thin strip: it winds between
 * neighbouring passes of the groove, so N turns of cut make about N - 1 turns of track.
 * `width` is the axial track width (pitch - kerf); returned widths are measured across it.
 */
export function trackGeometry(turns: number, pitch: number, kerf: number, circ: number) {
  const turnLen = Math.hypot(circ, pitch);             // one turn of a helix, unrolled
  const cos = circ / turnLen;                          // track direction vs the circumference
  return { length: Math.max(0, turns - 1) * turnLen, width: (pitch - kerf) * cos, turnLen };
}
