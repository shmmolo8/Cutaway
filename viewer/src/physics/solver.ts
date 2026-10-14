/**
 * 2D steady conduction in a thin resistive sheet: div(sigma grad V) = 0.
 *
 * Cell-centred finite differences on a uniform grid, red-black SOR. Cell types:
 *   FILM   free potential        HIGH  held at V = 1 (film shorted by the + electrode)
 *   LOW    held at V = 0         INSUL no conduction (trim kerf); zero-flux boundary
 * Sheet conductance is 1 per square, so the dimensionless resistance r = 1 / I and the
 * real resistance is R = R_sheet * r. The outer boundary is zero-flux (film edge), except
 * that a `periodicY` grid wraps around in y (a film on a cylinder, unrolled).
 */
export const FILM = 0, HIGH = 1, LOW = 2, INSUL = 3;
/** FIXV: held at its own value from `grid.fixed` (a tap such as a potentiometer wiper). */
export const FIXV = 4;

export interface Grid {
  nx: number;
  ny: number;
  x0: number; y0: number;           // domain min corner (mm)
  dx: number; dy: number;           // cell size (mm)
  type: Uint8Array;                 // nx*ny, row-major (j*nx + i)
  periodicY?: boolean;              // row ny-1 neighbours row 0 (cylinder circumference)
  pathLength?: number;              // longest current path (mm), if longer than the grid (a spiral)
  fixed?: Float32Array;             // potential of FIXV cells
}

export interface Solution {
  V: Float32Array;                  // potential, 0..1 (insulator cells hold an extrapolated value)
  jx: Float32Array; jy: Float32Array;   // current density at cell centres (per unit sheet conductance)
  q: Float32Array;                  // |J|^2 (heat density shape)
  iIn: number; iOut: number;        // current leaving HIGH / entering LOW (for V = 1)
  iFix: number;                     // current entering FIXV cells (0 without a tap)
  r: number;                        // dimensionless resistance 1 / I
  iterations: number;
}

export function makeGrid(x0: number, y0: number, x1: number, y1: number, nx: number, dyWanted?: number,
  periodicY = false): Grid {
  const dx = (x1 - x0) / nx;
  let ny = Math.max(8, Math.round((y1 - y0) / (dyWanted ?? dx)));
  if (periodicY) ny += ny & 1;       // even, so red-black colouring holds across the seam
  return { nx, ny, x0, y0, dx, dy: (y1 - y0) / ny, type: new Uint8Array(nx * ny), periodicY };
}

/** Neighbour indices (self where there is none: outer edge without wrap). */
function neighbours(g: Grid) {
  const { nx, ny } = g, n = nx * ny;
  const kl = new Int32Array(n), kr = new Int32Array(n), kd = new Int32Array(n), ku = new Int32Array(n);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i;
    kl[k] = i > 0 ? k - 1 : k;
    kr[k] = i < nx - 1 ? k + 1 : k;
    kd[k] = j > 0 ? k - nx : g.periodicY ? k + (ny - 1) * nx : k;
    ku[k] = j < ny - 1 ? k + nx : g.periodicY ? i : k;
  }
  return { kl, kr, kd, ku };
}

/** Mark every cell whose centre lies inside the axis-aligned rectangle. */
export function fillRect(g: Grid, xa: number, xb: number, ya: number, yb: number, t: number): void {
  const [x_lo, x_hi] = xa < xb ? [xa, xb] : [xb, xa];
  const [y_lo, y_hi] = ya < yb ? [ya, yb] : [yb, ya];
  for (let j = 0; j < g.ny; j++) {
    const y = g.y0 + (j + 0.5) * g.dy;
    if (y < y_lo || y > y_hi) continue;
    for (let i = 0; i < g.nx; i++) {
      const x = g.x0 + (i + 0.5) * g.dx;
      if (x >= x_lo && x <= x_hi) g.type[j * g.nx + i] = t;
    }
  }
}

/**
 * `tol` bounds the per-sweep change; with omega near 2 on long current paths that alone
 * stops early, so iteration also continues until current in and out agree to `balance`.
 */
export function solve(g: Grid, warm?: Float32Array, tol = 1e-6, maxIter = 20000, balance = 1e-3): Solution {
  const { nx, ny, type } = g;
  const n = nx * ny;
  // double precision: on a long track (many squares) the current is tiny next to V, and
  // float32 rounding of V alone would unbalance current in vs out by percents
  const V = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const t = type[k];
    V[k] = t === HIGH ? 1 : t === LOW ? 0 : t === FIXV ? g.fixed![k] : warm ? warm[k] : 1 - ((k % nx) + 0.5) / nx;
  }
  const { kl, kr, kd, ku } = neighbours(g);
  const ax = 1 / (g.dx * g.dx), ay = 1 / (g.dy * g.dy);
  // SOR converges like a grid as long as the longest current path: a helical track is
  // many times the grid size, and omega must be chosen for that length
  const span = Math.max(nx, ny, (g.pathLength ?? 0) / Math.min(g.dx, g.dy));
  const omega = 2 / (1 + Math.sin(Math.PI / span));
  // a neighbour conducts if it exists (not self) and is not an insulator
  const cond = (k: number, m: number) => m !== k && type[m] !== INSUL;
  // a fixed (HIGH/LOW) cell's potential sits on its face, half a cell from a FILM centre,
  // so that coupling (and the flux through it) is doubled
  const fx = (k: number) => (type[k] === FILM ? 1 : 2);
  // precomputed normalised neighbour weights (0 across insulators / the outer edge); float64
  // too, so they sum to 1: a float32 rounding bias per cell adds up to a current imbalance
  const wl = new Float64Array(n), wr = new Float64Array(n), wd = new Float64Array(n), wu = new Float64Array(n);
  const free: number[][] = [[], []];                 // FILM cells by red/black colour
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i;
    if (type[k] !== FILM) continue;
    const l = cond(k, kl[k]) ? ax * fx(kl[k]) : 0, r = cond(k, kr[k]) ? ax * fx(kr[k]) : 0;
    const d = cond(k, kd[k]) ? ay * fx(kd[k]) : 0, u = cond(k, ku[k]) ? ay * fx(ku[k]) : 0;
    const w = l + r + d + u;
    if (!w) continue;
    wl[k] = l / w; wr[k] = r / w; wd[k] = d / w; wu[k] = u / w;
    free[(i + j) & 1].push(k);
  }
  const sets = free.map((f) => Int32Array.from(f));

  // currents: face flux (V_a - V_b) * (face length / centre distance), contact faces only
  const gx = g.dy / g.dx, gy = g.dx / g.dy;
  const half = (a: number, b: number) => (a !== FILM) !== (b !== FILM) ? 2 : 1;   // fixed-FILM face
  const contactFaces: number[] = [];                  // (k, m, sign of iIn, iOut, iFix, gf) per face
  for (let k = 0; k < n; k++) {
    for (const [m, gf] of [[kr[k], gx], [ku[k], gy]] as const) {   // each face once: right and up
      if (type[k] === INSUL || !cond(k, m)) continue;
      const t = type[k], t2 = type[m];
      const sin = t === HIGH && t2 !== HIGH ? 1 : t2 === HIGH && t !== HIGH ? -1 : 0;
      const sout = t2 === LOW && t !== LOW ? 1 : t === LOW && t2 !== LOW ? -1 : 0;
      const sfix = t2 === FIXV && t !== FIXV ? 1 : t === FIXV && t2 !== FIXV ? -1 : 0;
      if (sin || sout || sfix) contactFaces.push(k, m, sin, sout, sfix, gf * half(t, t2));
    }
  }
  const fluxes = () => {
    let iIn = 0, iOut = 0, iFix = 0;
    for (let c = 0; c < contactFaces.length; c += 6) {
      const f = (V[contactFaces[c]] - V[contactFaces[c + 1]]) * contactFaces[c + 5];
      iIn += contactFaces[c + 2] * f;
      iOut += contactFaces[c + 3] * f;
      iFix += contactFaces[c + 4] * f;
    }
    return { iIn, iOut, iFix };
  };

  let it = 0;
  for (; it < maxIter; it++) {
    let maxDelta = 0;
    for (const set of sets) {
      for (let m = 0; m < set.length; m++) {
        const k = set[m];
        const target = wl[k] * V[kl[k]] + wr[k] * V[kr[k]] + wd[k] * V[kd[k]] + wu[k] * V[ku[k]];
        const d = omega * (target - V[k]);
        V[k] += d;
        const ad = d < 0 ? -d : d;
        if (ad > maxDelta) maxDelta = ad;
      }
    }
    if (maxDelta < tol) {
      const { iIn, iOut, iFix } = fluxes();
      if (Math.abs(iIn - iOut - iFix) <= balance * Math.abs(iIn + iOut) / 2) break;
    }
  }

  const { iIn, iOut, iFix } = fluxes();
  const jx = new Float32Array(n), jy = new Float32Array(n), q = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    if (type[k] !== FILM) continue;
    // centre current density: mean of the two face fluxes on each axis (0 at insulators)
    const fl = cond(k, kl[k]) ? (fx(kl[k]) * (V[kl[k]] - V[k])) / g.dx : 0;
    const fr = cond(k, kr[k]) ? (fx(kr[k]) * (V[k] - V[kr[k]])) / g.dx : 0;
    const fd = cond(k, kd[k]) ? (fx(kd[k]) * (V[kd[k]] - V[k])) / g.dy : 0;
    const fu = cond(k, ku[k]) ? (fx(ku[k]) * (V[k] - V[ku[k]])) / g.dy : 0;
    jx[k] = (fl + fr) / 2;
    jy[k] = (fd + fu) / 2;
    q[k] = jx[k] * jx[k] + jy[k] * jy[k];
  }

  // extrapolate V into insulator cells so texture filtering is smooth at kerf edges
  for (let pass = 0; pass < 4; pass++) {
    for (let k = 0; k < n; k++) {
      if (type[k] !== INSUL) continue;
      let s = 0, c = 0;
      for (const m of [kl[k], kr[k], kd[k], ku[k]]) {
        if (m !== k) { s += V[m]; c++; }
      }
      if (c) V[k] = s / c;
    }
  }
  const I = (iIn + iOut) / 2;
  return { V: Float32Array.from(V), jx, jy, q, iIn, iOut, iFix, r: 1 / I, iterations: it };
}

/** Bilinear sample of a cell-centred field. */
export function sample(g: Grid, f: Float32Array, x: number, y: number): number {
  const fx = Math.min(Math.max((x - g.x0) / g.dx - 0.5, 0), g.nx - 1.001);
  let fy = (y - g.y0) / g.dy - 0.5;
  fy = g.periodicY ? fy - Math.floor(fy / g.ny) * g.ny : Math.min(Math.max(fy, 0), g.ny - 1.001);
  const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j;
  const k = j * g.nx + i;
  const k2 = g.periodicY && j === g.ny - 1 ? i : k + g.nx;        // row above (wraps)
  return (f[k] * (1 - u) + f[k + 1] * u) * (1 - v) + (f[k2] * (1 - u) + f[k2 + 1] * u) * v;
}

export interface Streamline {
  pts: Float32Array;        // x, y pairs (mm)
  speed: Float32Array;      // |J| at each point (relative)
  len: Float32Array;        // cumulative arc length (mm)
}

/**
 * Streamlines seeded at equal-current intervals along the HIGH boundary, so their
 * spacing is inversely proportional to current density (they crowd where J is high).
 */
export function streamlines(g: Grid, s: Solution, count: number): Streamline[] {
  const { nx, ny, type } = g;
  const seeds: { x: number; y: number; f: number }[] = [];
  // every HIGH -> FILM face (any direction: a curved track leaves its contact at an angle),
  // weighted by the current through it; seeds start just inside the film cell
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i;
    if (type[k] !== HIGH) continue;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || ii >= nx || jj < 0 || jj >= ny || type[jj * nx + ii] !== FILM) continue;
      const m = jj * nx + ii;
      seeds.push({ x: g.x0 + (i + 0.5 + di * 1.0) * g.dx, y: g.y0 + (j + 0.5 + dj * 1.0) * g.dy,
        f: Math.max(0, s.V[k] - s.V[m]) * (dj ? g.dx / g.dy : g.dy / g.dx) });
    }
  }
  const total = seeds.reduce((a, b) => a + b.f, 0);
  if (!total) return [];
  const h = 0.5 * Math.min(g.dx, g.dy);
  const typeAt = (x: number, y: number) => {
    const i = Math.floor((x - g.x0) / g.dx);
    let j = Math.floor((y - g.y0) / g.dy);
    if (g.periodicY) j = ((j % ny) + ny) % ny;
    if (i < 0 || j < 0 || i >= nx || j >= ny) return -1;
    return type[j * nx + i];
  };
  const out: Streamline[] = [];
  let acc = 0, si = 0;
  for (let n = 0; n < count; n++) {
    const target = ((n + 0.5) / count) * total;
    while (si < seeds.length - 1 && acc + seeds[si].f < target) acc += seeds[si++].f;
    let x = seeds[si].x, y = seeds[si].y;
    const pts: number[] = [], sp: number[] = [], len: number[] = [];
    let L = 0;
    for (let step = 0; step < 20000; step++) {
      const jxa = sample(g, s.jx, x, y), jya = sample(g, s.jy, x, y);
      const m = Math.hypot(jxa, jya);
      pts.push(x, y); sp.push(m); len.push(L);
      if (m < 1e-9) break;
      // RK2 midpoint along the unit direction
      const xm = x + (jxa / m) * h / 2, ym = y + (jya / m) * h / 2;
      const jxb = sample(g, s.jx, xm, ym), jyb = sample(g, s.jy, xm, ym), mb = Math.hypot(jxb, jyb);
      if (mb < 1e-9) break;
      x += (jxb / mb) * h; y += (jyb / mb) * h; L += h;
      const t = typeAt(x, y);
      if (t === LOW || t === FIXV || t === -1) { pts.push(x, y); sp.push(mb); len.push(L); break; }
      if (t === INSUL || t === HIGH) break;
    }
    if (pts.length > 4) out.push({ pts: Float32Array.from(pts), speed: Float32Array.from(sp), len: Float32Array.from(len) });
  }
  return out;
}

/** Value at the given fraction of the sorted film-cell values (robust normalisation). */
export function percentile(g: Grid, f: Float32Array, p: number): number {
  const vals: number[] = [];
  for (let k = 0; k < f.length; k++) if (g.type[k] === FILM) vals.push(f[k]);
  if (!vals.length) return 1;
  vals.sort((a, b) => a - b);
  return vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] || 1;
}

/**
 * Coarse-to-fine solve: `build(nx)` rasterises the same geometry at any resolution.
 * Each level starts from the bilinear interpolation of the previous one, so the fine
 * grid needs only a few sweeps. Pass `warm` (same grid) to skip the ladder entirely.
 */
export function solveLadder(build: (nx: number) => Grid, nx: number, warm?: Float32Array, tol = 2e-6): { grid: Grid; sol: Solution } {
  if (warm) {
    const grid = build(nx);
    return { grid, sol: solve(grid, warm, tol) };
  }
  let prev: { grid: Grid; sol: Solution } | null = null;
  for (const n of [Math.round(nx / 4), Math.round(nx / 2), nx]) {
    const grid = build(n);
    let guess: Float32Array | undefined;
    if (prev) {
      guess = new Float32Array(grid.nx * grid.ny);
      for (let j = 0; j < grid.ny; j++) for (let i = 0; i < grid.nx; i++)
        guess[j * grid.nx + i] = sample(prev.grid, prev.sol.V, grid.x0 + (i + 0.5) * grid.dx, grid.y0 + (j + 0.5) * grid.dy);
    }
    prev = { grid, sol: solve(grid, guess, n === nx ? tol : tol * 10, 20000, n === nx ? 1e-3 : 1e-2) };
  }
  return prev!;
}

/**
 * Variable-coefficient Poisson: div(nu grad A) = -src on the grid, A = 0 on the outer ring.
 * Used for 2D magnetostatics (A = out-of-plane vector potential / mu0, nu = 1/mu_r,
 * src = current density). Face coefficients are harmonic means. Returns A per cell.
 */
export interface PoissonProblem {
  grid: Grid; nu: Float32Array; src: Float32Array;
  zero?: Uint8Array;                // cells held at A = 0 (e.g. the axis of an axisymmetric solve)
}

export function solvePoisson(p: PoissonProblem, warm?: Float32Array, tol = 1e-6, maxIter = 30000):
  { A: Float32Array; iterations: number } {
  const { grid: g, nu, src } = p, { nx, ny } = g, n = nx * ny;
  const A = warm ? Float32Array.from(warm) : new Float32Array(n);
  if (p.zero) for (let k = 0; k < n; k++) if (p.zero[k]) A[k] = 0;
  const ax = 1 / (g.dx * g.dx), ay = 1 / (g.dy * g.dy);
  const hm = (a: number, b: number) => (2 * a * b) / (a + b);
  const wl = new Float32Array(n), wr = new Float32Array(n), wd = new Float32Array(n), wu = new Float32Array(n), s = new Float32Array(n);
  const sets: number[][] = [[], []];
  for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const k = j * nx + i;
    if (p.zero?.[k]) continue;
    const l = ax * hm(nu[k], nu[k - 1]), r = ax * hm(nu[k], nu[k + 1]);
    const d = ay * hm(nu[k], nu[k - nx]), u = ay * hm(nu[k], nu[k + nx]);
    const w = l + r + d + u;
    wl[k] = l / w; wr[k] = r / w; wd[k] = d / w; wu[k] = u / w; s[k] = src[k] / w;
    sets[(i + j) & 1].push(k);
  }
  const packed = sets.map((x) => Int32Array.from(x));
  const omega = 2 / (1 + Math.sin(Math.PI / Math.max(nx, ny)));
  let it = 0, scale = 1e-30;
  for (; it < maxIter; it++) {
    let maxDelta = 0;
    for (const set of packed) for (let m = 0; m < set.length; m++) {
      const k = set[m];
      const d = omega * (wl[k] * A[k - 1] + wr[k] * A[k + 1] + wd[k] * A[k - nx] + wu[k] * A[k + nx] + s[k] - A[k]);
      A[k] += d;
      const ad = d < 0 ? -d : d;
      if (ad > maxDelta) maxDelta = ad;
      const aa = A[k] < 0 ? -A[k] : A[k];
      if (aa > scale) scale = aa;
    }
    if (maxDelta < tol * scale) break;
  }
  return { A, iterations: it };
}

/**
 * Same equation as `solvePoisson`, by conjugate gradients with a diagonal (Jacobi)
 * preconditioner, in float64. Robust where SOR crawls: large coefficient contrast (ferrite
 * mu_r ~ 250) times the 1/r of an axisymmetric solve. Solves sum_f c_f (A_k - A_f) = src_k
 * over interior, non-`zero` cells; the outer ring and `zero` cells hold A = 0.
 */
export function solvePoissonCG(p: PoissonProblem, warm?: Float32Array, rtol = 1e-7, maxIter = 20000):
  { A: Float32Array; iterations: number } {
  const { grid: g, nu, src } = p, { nx, ny } = g, n = nx * ny;
  const ax = 1 / (g.dx * g.dx), ay = 1 / (g.dy * g.dy);
  const hm = (a: number, b: number) => (2 * a * b) / (a + b);
  const act: number[] = [];
  for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const k = j * nx + i;
    if (!p.zero?.[k]) act.push(k);
  }
  const free = new Uint8Array(n);
  for (const k of act) free[k] = 1;
  const cl = new Float64Array(n), cr = new Float64Array(n), cd = new Float64Array(n), cu = new Float64Array(n), dg = new Float64Array(n);
  for (const k of act) {
    cl[k] = ax * hm(nu[k], nu[k - 1]); cr[k] = ax * hm(nu[k], nu[k + 1]);
    cd[k] = ay * hm(nu[k], nu[k - nx]); cu[k] = ay * hm(nu[k], nu[k + nx]);
    dg[k] = cl[k] + cr[k] + cd[k] + cu[k];
  }
  const x = new Float64Array(n);
  if (warm) for (const k of act) x[k] = warm[k];
  const mul = (v: Float64Array, out: Float64Array) => {   // out = A v (fixed cells contribute 0)
    for (const k of act) {
      out[k] = dg[k] * v[k] - (free[k - 1] ? cl[k] * v[k - 1] : 0) - (free[k + 1] ? cr[k] * v[k + 1] : 0)
        - (free[k - nx] ? cd[k] * v[k - nx] : 0) - (free[k + nx] ? cu[k] * v[k + nx] : 0);
    }
  };
  const r = new Float64Array(n), z = new Float64Array(n), d = new Float64Array(n), q = new Float64Array(n);
  mul(x, q);
  let bn = 0;
  for (const k of act) { r[k] = src[k] - q[k]; bn += src[k] * src[k]; }
  bn = Math.sqrt(bn) || 1;
  let rz = 0;
  for (const k of act) { z[k] = r[k] / dg[k]; d[k] = z[k]; rz += r[k] * z[k]; }
  let it = 0;
  for (; it < maxIter; it++) {
    mul(d, q);
    let dq = 0;
    for (const k of act) dq += d[k] * q[k];
    const alpha = rz / dq;
    let rn = 0;
    for (const k of act) { x[k] += alpha * d[k]; r[k] -= alpha * q[k]; rn += r[k] * r[k]; }
    if (Math.sqrt(rn) < rtol * bn) break;
    let rz2 = 0;
    for (const k of act) { z[k] = r[k] / dg[k]; rz2 += r[k] * z[k]; }
    const beta = rz2 / rz;
    rz = rz2;
    for (const k of act) d[k] = z[k] + beta * d[k];
  }
  return { A: Float32Array.from(x), iterations: it };
}

/** Coarse-to-fine Poisson solve; `build(nx)` returns the problem at any resolution. */
export function solvePoissonLadder<P extends PoissonProblem>(build: (nx: number) => P, nx: number, cg = false): P & { A: Float32Array } {
  let prev: (P & { A: Float32Array }) | null = null;
  for (const n of [Math.round(nx / 4), Math.round(nx / 2), nx]) {
    const p = build(n);
    let guess: Float32Array | undefined;
    if (prev) {
      guess = new Float32Array(p.grid.nx * p.grid.ny);
      for (let j = 1; j < p.grid.ny - 1; j++) for (let i = 1; i < p.grid.nx - 1; i++)
        guess[j * p.grid.nx + i] = sample(prev.grid, prev.A, p.grid.x0 + (i + 0.5) * p.grid.dx, p.grid.y0 + (j + 0.5) * p.grid.dy);
    }
    prev = { ...p, A: (cg ? solvePoissonCG(p, guess, n === nx ? 1e-7 : 1e-5) : solvePoisson(p, guess, n === nx ? 1e-6 : 1e-5)).A };
  }
  return prev!;
}

/** Contours of a cell-centred field (marching squares), chained into polylines. */
export function contours(g: Grid, f: Float32Array, levels: number[]): { level: number; pts: number[] }[] {
  const { nx, ny } = g;
  const X = (i: number) => g.x0 + (i + 0.5) * g.dx, Y = (j: number) => g.y0 + (j + 0.5) * g.dy;
  const out: { level: number; pts: number[] }[] = [];
  for (const lv of levels) {
    const segs: [number, number, number, number][] = [];
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const v = [f[j * nx + i], f[j * nx + i + 1], f[(j + 1) * nx + i + 1], f[(j + 1) * nx + i]];
      const c = [[X(i), Y(j)], [X(i + 1), Y(j)], [X(i + 1), Y(j + 1)], [X(i), Y(j + 1)]];
      const hits: number[][] = [];
      for (let e = 0; e < 4; e++) {
        const a = v[e] - lv, b = v[(e + 1) % 4] - lv;
        if ((a < 0) !== (b < 0)) {
          const t = a / (a - b);
          hits.push([c[e][0] + t * (c[(e + 1) % 4][0] - c[e][0]), c[e][1] + t * (c[(e + 1) % 4][1] - c[e][1])]);
        }
      }
      if (hits.length === 2) segs.push([hits[0][0], hits[0][1], hits[1][0], hits[1][1]]);
      else if (hits.length === 4) segs.push([hits[0][0], hits[0][1], hits[1][0], hits[1][1]], [hits[2][0], hits[2][1], hits[3][0], hits[3][1]]);
    }
    // chain segments sharing endpoints
    const key = (x: number, y: number) => `${Math.round(x * 1e6)},${Math.round(y * 1e6)}`;
    const ends = new Map<string, number[]>();
    segs.forEach((s, idx) => {
      for (const k of [key(s[0], s[1]), key(s[2], s[3])]) (ends.get(k) ?? ends.set(k, []).get(k)!).push(idx);
    });
    const used = new Uint8Array(segs.length);
    for (let s0 = 0; s0 < segs.length; s0++) {
      if (used[s0]) continue;
      used[s0] = 1;
      let pts = [segs[s0][0], segs[s0][1], segs[s0][2], segs[s0][3]];
      for (const dir of [1, -1]) {
        for (;;) {
          const [x, y] = dir > 0 ? [pts[pts.length - 2], pts[pts.length - 1]] : [pts[0], pts[1]];
          const next = (ends.get(key(x, y)) ?? []).find((q) => !used[q]);
          if (next === undefined) break;
          used[next] = 1;
          const s = segs[next];
          const far = key(s[0], s[1]) === key(x, y) ? [s[2], s[3]] : [s[0], s[1]];
          pts = dir > 0 ? [...pts, ...far] : [...far, ...pts];
        }
      }
      if (pts.length >= 6) out.push({ level: lv, pts });
    }
  }
  return out;
}
