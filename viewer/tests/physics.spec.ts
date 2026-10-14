import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {} from "../src/main";

const outDir = fileURLToPath(new URL("../../.test-output/screenshots/physics/", import.meta.url));
mkdirSync(outDir, { recursive: true });

async function open(page: Page, query: string) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(`./?${query}`);
  await page.waitForFunction(() => window.__ready === true);
  return errors;
}

async function shot(page: Page, name: string) {
  // software GL can take many seconds per screenshot: freeze animation time meanwhile, so a
  // staged sequence is still at the same stage afterwards
  await page.evaluate(() => { window.__app!.viewer.timeScale = 0; });
  await page.evaluate(() => new Promise<void>((resolve) => {
    const v = window.__app!.viewer;
    const start = v.frameCount;
    v.invalidate();
    const tick = () => {
      if (v.frameCount > start + 1) return resolve();
      v.invalidate();                      // rendering is on demand: ask for each frame
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
  await page.screenshot({ path: `${outDir}${name}.png` });
  await page.evaluate(() => { window.__app!.viewer.timeScale = 1; });
}

const BASE = "component=chip_resistor_0603&variant=exaggerated&theme=dark";

test("solver: exact case, conservation, resistance vs trim", async ({ page }) => {
  const errors = await open(page, `${BASE}&preset=exterior&instant=1&physics=1`);
  const d = await page.evaluate(() => {
    const ph = window.__app!.physics;
    const trims = [0, 25, 50, 75, 100, ph.maxTrimPct()];
    return { diag: ph.diagnostics(), R: trims.map((t) => ph.resistanceAt(t)), readout: ph.readout() };
  });
  expect(Math.abs(d.diag.r0 - d.diag.r0Exact) / d.diag.r0Exact).toBeLessThan(0.01);   // untrimmed = L/W squares
  expect(Math.abs(d.diag.iIn - d.diag.iOut) / d.diag.iIn).toBeLessThan(0.005);       // current conserved
  for (let i = 1; i < d.R.length; i++) expect(d.R[i]).toBeGreaterThan(d.R[i - 1]);   // trimming raises R
  expect(d.R[4]).toBeCloseTo(10000, -1);                                              // modelled trim = 10 kΩ
  expect(d.readout!.R).toBeCloseTo(10000, -1);
  expect(d.diag.lines).toBeGreaterThan(30);
  console.log("R vs trim:", d.R.map((r) => r.toFixed(0)).join(", "), "| r0", d.diag.r0.toFixed(4), "exact", d.diag.r0Exact.toFixed(4));
  expect(errors).toEqual([]);
});

test("potential, equipotentials and current (plan)", async ({ page }) => {
  const errors = await open(page, `${BASE}&preset=exterior&instant=1&physics=1`);
  await expect(page.locator("#physics-hud")).toBeVisible();
  await shot(page, "potential_oblique");
  await page.evaluate(() => {
    const app = window.__app!, m = app.model!;
    app.viewer.frameBox(m.worldBox(), m.cadDirToWorld([0, -0.001, 1]), { margin: 1.0 });
  });
  await shot(page, "potential_plan");
  expect(errors).toEqual([]);
});

test("heat map with hot spot at the trim tip", async ({ page }) => {
  const errors = await open(page, `${BASE}&preset=exterior&instant=1&physics=play`);
  await page.evaluate(() => {
    const app = window.__app!, m = app.model!;
    app.viewer.frameBox(m.worldBox(), m.cadDirToWorld([0, -0.001, 1]), { margin: 1.0 });
  });
  await shot(page, "heat_plan");
  await page.evaluate(() => {
    const app = window.__app!, m = app.model!;
    app.viewer.frameBox(m.worldBox(), m.cadDirToWorld([0.5, -1.1, 0.9]), {});
  });
  await shot(page, "heat_oblique_spread");
  expect(errors).toEqual([]);
});

test("heat on the section caps", async ({ page }) => {
  const errors = await open(page, `${BASE}&preset=exterior&instant=1&physics=play`);
  await page.evaluate(() => window.__app!.applyPreset("longitudinal", { animate: false }));
  await shot(page, "heat_longitudinal_section");
  await page.evaluate(() => {
    const app = window.__app!;
    app.physics.set("heat", false);
    const t = app.model!.meta.physics!.trim;
    app.section.setFromMeta({ normal: [0, 1, 0], point: [0, t.y_tip - 0.01 * t.sy * -1, 0] });
  });
  await shot(page, "potential_section_near_tip");
  expect(errors).toEqual([]);
});

test("trim slider and over-rating", async ({ page }) => {
  const errors = await open(page, `${BASE}&preset=exterior&instant=1&physics=play`);
  await page.evaluate(() => {
    const app = window.__app!, m = app.model!;
    app.physics.setTrim(0);
    app.viewer.frameBox(m.worldBox(), m.cadDirToWorld([0, -0.001, 1]), { margin: 1.0 });
  });
  await page.waitForTimeout(600);
  await shot(page, "heat_untrimmed");
  await page.evaluate(() => {
    const ph = window.__app!.physics;
    ph.setTrim(ph.maxTrimPct());
    ph.set("voltage", 60);
  });
  await page.waitForTimeout(600);
  await expect(page.locator("#physics-hud .over")).toHaveCount(1);
  await shot(page, "heat_max_trim_overrated");
  expect(errors).toEqual([]);
});

test("animated sequence mid-way (current stage)", async ({ page }) => {
  const errors = await open(page, `${BASE}&preset=exterior&physics=play`);
  // first frames compile ~20 shader programs (seconds in software GL): wait for the stage itself
  await expect(page.locator("#physics-hud .stage")).toContainText("Current flows", { timeout: 20_000 });
  await shot(page, "sequence_stage3");
  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------- MLCC (plate capacitor)
const MLCC = "component=mlcc_0603&variant=exaggerated&theme=dark";

test("MLCC solver: C vs parallel-plate, conservation, mid-gap potential", async ({ page }) => {
  const errors = await open(page, `${MLCC}&preset=exterior&instant=1&physics=1`);
  const d = await page.evaluate(() => window.__app!.capPhysics.diagnostics());
  console.log("MLCC C =", d.C.toExponential(3), "ideal", d.Cideal.toExponential(3), "ratio", (d.C / d.Cideal).toFixed(3), "midV", d.midGapV.toFixed(3));
  expect(d.C / d.Cideal).toBeGreaterThan(1.0);        // fringing only adds capacitance
  expect(d.C / d.Cideal).toBeLessThan(1.25);
  expect(Math.abs(d.iIn - d.iOut) / d.iIn).toBeLessThan(0.005);
  expect(Math.abs(d.midGapV - 0.5)).toBeLessThan(0.03);
  await expect(page.locator("#physics-hud")).toContainText("C (this model)");
  await shot(page, "mlcc_potential_section");
  expect(errors).toEqual([]);
});

test("MLCC field strength, field lines, charges and dipoles", async ({ page }) => {
  const errors = await open(page, `${MLCC}&preset=exterior&instant=1&physics=play`);
  await shot(page, "mlcc_field_strength");
  await page.evaluate(() => {
    const app = window.__app!, m = app.model!;
    const box = m.worldBox();
    // zoom on the right end: electrode tips, end margin and termination
    const c = m.cadPointToWorld([0.55, 0, 0.4]);
    const half = new (window.THREE_NS!.Vector3)(0.22, 0.22, 0.22);
    box.set(c.clone().sub(half), c.clone().add(half));
    app.viewer.frameBox(box, m.cadDirToWorld([0, -1, 0.05]), { margin: 1.0 });
  });
  await shot(page, "mlcc_tips_closeup");
  expect(errors).toEqual([]);
});

test("MLCC charging sequence (stage 2 graph)", async ({ page }) => {
  const errors = await open(page, `${MLCC}&preset=exterior&physics=play`);
  await expect(page.locator("#physics-hud .stage")).toContainText("Charging", { timeout: 20_000 });
  await expect(page.locator("#physics-hud svg.chart")).toHaveCount(1);
  await shot(page, "mlcc_sequence_charging");
  await expect(page.locator("#physics-hud .stage")).toContainText("polarises", { timeout: 20_000 });
  await shot(page, "mlcc_sequence_polarising");
  expect(errors).toEqual([]);
});

test("MLCC AC: reactance, resonance, phase and filtering", async ({ page }) => {
  const errors = await open(page, `${MLCC}&preset=exterior&instant=1&physics=1`);
  const r = await page.evaluate(() => {
    const cap = window.__app!.capPhysics;
    cap.setAc(true);
    const at = (lf: number) => { cap.set("freqLog", lf); return cap.readoutAc()!; };
    return { mhz: at(6), khz: at(3), ghz: at(8), low: at(1) };
  });
  console.log("AC: Xc(1MHz)", r.mhz.Xc.toFixed(4), "SRF", (r.mhz.srf / 1e6).toFixed(2), "MHz",
    "phase 1kHz", r.khz.phaseDeg.toFixed(1), "phase 100MHz", r.ghz.phaseDeg.toFixed(1),
    "atten 10Hz", r.low.atten.toFixed(4), "atten 1MHz", r.mhz.atten.toFixed(4));
  expect(r.mhz.Xc).toBeCloseTo(1 / (2 * Math.PI * 1e6 * 1e-6), 5);
  expect(r.mhz.srf / 1e6).toBeCloseTo(6.015, 2);
  expect(r.khz.phaseDeg).toBeLessThan(-89);          // capacitive: current leads by ~90 degrees
  expect(r.ghz.phaseDeg).toBeGreaterThan(80);        // above resonance: inductive (ESL)
  expect(r.low.atten).toBeGreaterThan(0.99);         // 10 Hz passes straight through
  expect(r.mhz.atten).toBeLessThan(0.2);             // 1 MHz noise strongly attenuated
  expect(errors).toEqual([]);
});

for (const [phase, name, disp] of [[90, "ac_peak_positive", false], [0, "ac_zero_crossing_displacement", true], [270, "ac_peak_negative", false]] as const) {
  test(`MLCC AC snapshot: ${name}`, async ({ page }) => {
    const errors = await open(page, `${MLCC}&preset=exterior&instant=1&physics=1`);
    await page.evaluate(([ph, d]) => {
      const cap = window.__app!.capPhysics;
      cap.setAc(true);
      cap.set("displacement", d);
      cap.state.paused = true;
      cap.set("phaseDeg", ph);
      window.__app!.reframePhysics();
    }, [phase, disp] as const);
    await expect(page.locator("#physics-hud")).toContainText("Impedance");
    await shot(page, `mlcc_${name}`);
    expect(errors).toEqual([]);
  });
}

// ---------------------------------------------------------------- inductor (coil magnetics)
const IND = "component=inductor_0603&variant=exaggerated&theme=dark";

test("inductor solver: Ampère, symmetry, ferrite vs air core", async ({ page }) => {
  const errors = await open(page, `${IND}&preset=exterior&instant=1&physics=1`);
  const d = await page.evaluate(() => {
    const ind = window.__app!.indPhysics;
    return { ...ind.diagnostics(), minusCuts: ind.meta!.cuts.filter((c) => c.dir < 0).length, muR: ind.meta!.electrical.mu_r };
  });
  console.log("IND:", JSON.stringify(d, (_, v) => (typeof v === "number" ? +v.toPrecision(4) : v)));
  expect(d.ampereEnclosed).toBeCloseTo(-d.minusCuts, 6);                                      // 1 A per cut
  expect(Math.abs(d.ampereLoop - d.ampereEnclosed) / Math.abs(d.ampereEnclosed)).toBeLessThan(0.02);  // ∮H·dl = I_enc
  const gain = d.bWindow / d.bWindowAir;                 // ferrite vs air core, same current
  expect(gain).toBeGreaterThan(1.5);
  expect(gain).toBeLessThan(d.muR);
  expect(d.bWindow).toBeGreaterThan(5 * d.bAbove);       // flux concentrated inside the coil
  expect(d.L2d).toBeGreaterThan(0);
  await shot(page, "ind_dc_field");
  expect(errors).toEqual([]);
});

test("inductor AC: reactance, resonance, phase, filtering; DC saturation", async ({ page }) => {
  const errors = await open(page, `${IND}&preset=exterior&instant=1&physics=1`);
  const r = await page.evaluate(() => {
    const ind = window.__app!.indPhysics;
    ind.set("current", 3 * ind.meta!.electrical.rated_current_a);
    const dc = ind.readout()!;
    ind.set("ac", true);
    const at = (lf: number) => { ind.set("freqLog", lf); return ind.readoutAc()!; };
    return { dc, mhz: at(6), ghz: at(9), low: at(1), hi: at(8) };
  });
  console.log("IND AC: XL(1MHz)", r.mhz.XL.toFixed(3), "SRF", (r.mhz.srf / 1e6).toFixed(1), "MHz phase 1MHz", r.mhz.phaseDeg.toFixed(1),
    "phase 1GHz", r.ghz.phaseDeg.toFixed(1), "atten 10Hz", r.low.atten.toFixed(4), "atten 100MHz", r.hi.atten.toExponential(2), "sat", r.dc.sat.toFixed(3));
  expect(r.mhz.XL).toBeCloseTo(2 * Math.PI * 1e6 * 1e-6, 6);
  expect(r.mhz.srf / 1e6).toBeCloseTo(100.66, 1);
  expect(r.mhz.phaseDeg).toBeGreaterThan(80);          // inductive: voltage leads current
  expect(r.ghz.phaseDeg).toBeLessThan(0);              // above resonance: capacitive
  expect(r.low.atten).toBeGreaterThan(0.99);           // DC-ish passes
  expect(r.hi.atten).toBeLessThan(0.05);               // 100 MHz noise blocked
  expect(r.dc.sat).toBeLessThan(0.97);                 // 3x rated: saturating
  await expect(page.locator("#physics-hud")).toContainText("Impedance");
  expect(errors).toEqual([]);
});

test("inductor snapshots: coil view, AC induced E, energize sequence", async ({ page }) => {
  const errors = await open(page, `${IND}&preset=exterior&instant=1&physics=1`);
  await page.evaluate(() => { const ind = window.__app!.indPhysics; ind.set("core", false); });
  await shot(page, "ind_coil_view");
  await page.evaluate(() => {
    const app = window.__app!, ind = app.indPhysics;
    ind.set("core", true); ind.set("ac", true); ind.set("induced", true); ind.state.paused = true; ind.set("phaseDeg", 0);
    app.reframePhysics();
  });
  await shot(page, "ind_ac_zero_crossing_induced");
  expect(errors).toEqual([]);
});

test("inductor energize sequence reaches the ferrite stage", async ({ page }) => {
  const errors = await open(page, `${IND}&preset=exterior&physics=play`);
  await expect(page.locator("#physics-hud .stage")).toContainText("ferrite concentrates", { timeout: 25_000 });
  await shot(page, "ind_sequence_core");
  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------- carbon film (helical track)
const CF = "component=carbon_film_resistor_0204&variant=exaggerated&theme=dark";

test("carbon film solver: uncut tube, conservation, R vs turns / width / thickness", async ({ page }) => {
  const errors = await open(page, `${CF}&preset=exterior&instant=1&physics=1`);
  const d = await page.evaluate(() => {
    const ph = window.__app!.helixPhysics, m = ph.meta!;
    const s = ph.state, e = m.electrical;
    const rho = e.resistivity_ohm_m, t = s.thicknessNm * 1e-9;
    const circ = 2 * Math.PI * m.radius;
    const uncutExact = (rho / t) * (m.contact_x[1] - m.contact_x[0]) / circ;
    const turns = [0, 2, 3, 4, 5, s.turns];
    return {
      uncut: ph.resistanceFor(0), uncutExact,
      R: turns.map((n) => ph.resistanceFor(n)),
      Rwide: ph.resistanceFor(3, 0.4), Rnarrow: ph.resistanceFor(3, 0.1),
      Rthick: ph.resistanceFor(s.turns, s.width, 2 * s.thicknessNm),
      cons: ph.conservation(), readout: ph.readout()!, nominal: e.nominal_ohm, tol: e.tolerance,
    };
  });
  console.log("carbon R vs turns:", d.R.map((r) => r.toFixed(0)).join(", "), "| uncut", d.uncut.toFixed(1), "exact", d.uncutExact.toFixed(1),
    "| formula", d.readout.rFormula.toFixed(0), "solved", d.readout.R.toFixed(0));
  expect(Math.abs(d.uncut / d.uncutExact - 1)).toBeLessThan(0.01);                      // tube = L / (pi D) squares
  expect(Math.abs(d.cons.iIn - d.cons.iOut) / d.cons.iIn).toBeLessThan(0.005);          // current conserved
  for (let i = 1; i < d.R.length; i++) expect(d.R[i]).toBeGreaterThan(d.R[i - 1]);      // longer track, higher R
  expect(d.Rnarrow).toBeGreaterThan(2 * d.Rwide);                                         // narrower track, higher R
  expect(d.Rthick / d.R[d.R.length - 1]).toBeCloseTo(0.5, 5);                            // R = rho/t * squares
  expect(Math.abs(d.readout.R / d.nominal - 1)).toBeLessThan(d.tol);                     // the modelled cut is in spec
  expect(d.readout.inTolerance).toBe(true);
  expect(Math.abs(d.readout.R / d.readout.rFormula - 1)).toBeLessThan(0.1);              // rho*l/(w*t) close to solved
  expect(d.cons.lines).toBeGreaterThan(30);
  expect(errors).toEqual([]);
});

test("carbon film: potential and heat along the spiral", async ({ page }) => {
  const errors = await open(page, `${CF}&preset=exterior&instant=1&physics=1`);
  await expect(page.locator("#physics-hud")).toContainText("Carbon track");
  await shot(page, "carbon_potential");
  await page.evaluate(() => window.__app!.helixPhysics.play(true));
  await shot(page, "carbon_heat");
  await page.evaluate(() => window.__app!.applyPreset("longitudinal", { animate: false }));
  await shot(page, "carbon_heat_longitudinal");
  expect(errors).toEqual([]);
});

test("carbon film sliders: thinner film, fewer turns, wider track; over-rating", async ({ page }) => {
  const errors = await open(page, `${CF}&preset=exterior&instant=1&physics=play`);
  const r0 = await page.evaluate(() => window.__app!.helixPhysics.readout()!.R);
  // thickness only rescales R_sheet = rho / t: same solution, exactly twice the resistance
  const r1 = await page.evaluate(() => {
    const ph = window.__app!.helixPhysics;
    ph.setGeometry({ thicknessNm: ph.state.thicknessNm / 2 });
    return ph.readout()!.R;
  });
  expect(r1 / r0).toBeCloseTo(2, 6);
  await page.evaluate(() => window.__app!.helixPhysics.setGeometry({ thicknessNm: 300, turns: 2.5, width: 0.4 }));
  await page.waitForTimeout(1500);                            // coarse solve, then the refined one
  const r2 = await page.evaluate(() => window.__app!.helixPhysics.readout()!);
  expect(r2.R).toBeLessThan(r0 / 3);
  await expect(page.locator("#physics-hud .over")).toHaveCount(2);   // out of tolerance and over power
  await shot(page, "carbon_few_turns_wide");
  expect(errors).toEqual([]);
});

test("carbon film animated sequence reaches the current stage", async ({ page }) => {
  const errors = await open(page, `${CF}&preset=exterior&physics=play`);
  await expect(page.locator("#physics-hud .stage")).toContainText("Current flows", { timeout: 20_000 });
  await shot(page, "carbon_sequence_stage3");
  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------- ceramic disc (plate capacitor, disc plates)
const DISC = "component=ceramic_disc_capacitor_d5&variant=exaggerated&theme=dark";

test("disc capacitor: C = eps A / d with rim fringing, conservation, sliders reshape the part", async ({ page }) => {
  const errors = await open(page, `${DISC}&preset=exterior&instant=1&physics=1`);
  const yExtent = () => page.evaluate(() => {
    const m = window.__app!.model!, b = new window.THREE_NS!.Box3();
    const g = m.byId.get("ceramic")!.mesh.geometry; g.computeBoundingBox();
    const e = m.byId.get("electrode_R")!.mesh.geometry; e.computeBoundingBox();
    b.copy(g.boundingBox!);
    return { ceramic: b.max.y - b.min.y, plateX: e.boundingBox!.max.x - e.boundingBox!.min.x };
  });
  const r0 = await page.evaluate(() => window.__app!.capPhysics.readout()!);
  const diag = await page.evaluate(() => window.__app!.capPhysics.diagnostics());
  const g0 = await yExtent();
  console.log("disc C", r0.C.toExponential(3), "ideal", r0.Cideal.toExponential(3), "fringe", r0.fringe.toFixed(3));
  expect(r0.fringe).toBeGreaterThan(1.0);
  expect(r0.fringe).toBeLessThan(1.15);
  expect(Math.abs(diag.iIn - diag.iOut) / diag.iIn).toBeLessThan(0.005);
  expect(Math.abs(r0.C / r0.Creal - 1)).toBeLessThan(0.2);              // the model is the marked 1 nF part
  // thicker ceramic: drawn twice as thick, re-solved, C about halves
  await page.evaluate(() => { const c = window.__app!.capPhysics; c.state.designD *= 2; c.redesign(); });
  await page.waitForTimeout(500);
  const r1 = await page.evaluate(() => window.__app!.capPhysics.readout()!);
  const g1 = await yExtent();
  expect(g1.ceramic / g0.ceramic).toBeCloseTo(2, 2);
  expect(r1.C / r0.C).toBeGreaterThan(0.45);
  expect(r1.C / r0.C).toBeLessThan(0.56);                               // ∝ 1/d (fringing grows a little)
  await shot(page, "disc_design_thick");
  // smaller plates: drawn smaller, C ∝ Ø²
  await page.evaluate(() => { const c = window.__app!.capPhysics; c.state.designD /= 2; c.state.designDia /= 2; c.redesign(); });
  await page.waitForTimeout(500);
  const r2 = await page.evaluate(() => window.__app!.capPhysics.readout()!);
  const g2 = await yExtent();
  expect(g2.plateX / g0.plateX).toBeCloseTo(0.5, 2);
  expect(r2.C / r0.C).toBeGreaterThan(0.24);
  expect(r2.C / r0.C).toBeLessThan(0.3);
  await expect(page.locator("#physics-hud")).toContainText("fringing");
  await shot(page, "disc_design_small_plates");
  expect(errors).toEqual([]);
});

test("disc capacitor charging sequence and AC", async ({ page }) => {
  const errors = await open(page, `${DISC}&preset=exterior&physics=play`);
  await expect(page.locator("#physics-hud .stage")).toContainText("Charging", { timeout: 20_000 });
  await shot(page, "disc_sequence_charging");
  await page.evaluate(() => { const c = window.__app!.capPhysics; c.setAc(true); });
  await expect(page.locator("#physics-hud")).toContainText("Impedance");
  await shot(page, "disc_ac");
  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------- aluminium electrolytic (computed)
const ALU = "component=aluminum_electrolytic_capacitor_d8&variant=exaggerated&theme=dark";

test("electrolytic: oxide thickness, field, etch gain, design what-if, reverse warning", async ({ page }) => {
  const errors = await open(page, `${ALU}&preset=exterior&instant=1&physics=1`);
  const d = await page.evaluate(() => {
    const el = window.__app!.elPhysics, s = el.state, r0 = el.readout()!;
    s.designVf *= 2;
    const thick = el.readout()!.Cdesign;
    s.designVf /= 2;
    return { r0, thick };
  });
  console.log("electrolytic d", d.r0.dNm.toFixed(1), "nm, E", d.r0.eVum.toFixed(0), "V/um, gain", d.r0.gain.toFixed(1));
  expect(d.r0.dNm).toBeCloseTo(32.2, 1);                         // 23 V x 1.4 nm/V
  expect(d.r0.eVum).toBeCloseTo(16 / 0.0322, 0);                 // V / d
  expect(d.r0.gain).toBeGreaterThan(20);                         // typical low-voltage etch gain
  expect(d.r0.gain).toBeLessThan(100);
  expect(d.r0.Cdesign / d.r0.C).toBeCloseTo(1, 2);               // sliders start at the real part
  expect(d.thick / d.r0.Cdesign).toBeCloseTo(0.5, 5);            // C ∝ 1/d
  await shot(page, "electrolytic_field");
  // a shorter foil trims the drawn winding (radius limit in the shader)
  const cut = await page.evaluate(() => {
    const el = window.__app!.elPhysics;
    el.state.designLength = el.state.designLength / 2;
    el.applyState();
    return el.U.uRadialCut.value.toArray();
  });
  expect(cut[3]).toBe(1);
  await shot(page, "electrolytic_short_foil");
  await page.evaluate(() => { const el = window.__app!.elPhysics; el.state.designLength *= 2; el.applyState(); });
  await page.evaluate(() => window.__app!.elPhysics.set("voltage", -5));
  await expect(page.locator("#physics-hud .over")).toContainText("Reverse voltage");
  await shot(page, "electrolytic_reverse");
  expect(errors).toEqual([]);
});

test("electrolytic charging sequence", async ({ page }) => {
  const errors = await open(page, `${ALU}&preset=exterior&physics=play`);
  await expect(page.locator("#physics-hud .stage")).toContainText("Charging", { timeout: 20_000 });
  await shot(page, "electrolytic_sequence_charging");
  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------- tantalum (same computed physics, pellet)
const TA = "component=tantalum_capacitor_2012&variant=exaggerated&theme=dark";

test("tantalum: Ta2O5 thickness and field, powder gain, pellet length trims the view, reverse warning", async ({ page }) => {
  const errors = await open(page, `${TA}&preset=exterior&instant=1&physics=1`);
  const r0 = await page.evaluate(() => window.__app!.elPhysics.readout()!);
  console.log("tantalum d", r0.dNm.toFixed(1), "nm, E", r0.eVum.toFixed(0), "V/um, gain", r0.gain.toFixed(0));
  expect(r0.dNm).toBeCloseTo(36, 1);                          // 20 V x 1.8 nm/V
  expect(r0.eVum).toBeCloseTo(6.3 / 0.036, 0);
  expect(r0.gain).toBeGreaterThan(100);
  expect(r0.Cdesign / r0.C).toBeCloseTo(1, 2);
  await expect(page.locator("#physics-hud")).toContainText("Ta₂O₅");
  await shot(page, "tantalum_field");
  const cut = await page.evaluate(() => {
    const el = window.__app!.elPhysics;
    el.state.designLength *= 0.5;
    el.applyState();
    return { u: el.U.uRadialCut.value.toArray(), axis: el.U.uCutAxis.value.toArray(), C: el.readout()!.Cdesign };
  });
  expect(cut.u[3]).toBe(1);
  expect(cut.axis).toEqual([1, 0]);
  expect(cut.C / r0.C).toBeCloseTo(0.5, 5);
  await shot(page, "tantalum_short_pellet");
  await page.evaluate(() => window.__app!.elPhysics.set("voltage", -3));
  await expect(page.locator("#physics-hud .over")).toContainText("ignite");
  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------- trimmer potentiometer (arc track, wiper tap)
const POT = "component=potentiometer_3266w&variant=exaggerated&theme=dark";

test("potentiometer: linear divider, conservation, loaded wiper, screw turns the rotor", async ({ page }) => {
  const errors = await open(page, `${POT}&preset=exterior&instant=1&physics=1`);
  const d = await page.evaluate(() => {
    const ph = window.__app!.arcPhysics;
    const turns = [0, 5, 12.5, 20, 25];
    return {
      v: turns.map((t) => ph.probe(t, null).v),
      un: ph.probe(12.5, null), ld: ph.probe(12.5, 10e3), total: ph.meta!.turns.total,
      R: ph.readout()!.R,
    };
  });
  console.log("pot v(turns):", d.v.map((x) => x.toFixed(3)).join(", "), "| loaded 10k at mid:", d.ld.v.toFixed(3));
  [0, 5, 12.5, 20, 25].forEach((t, i) => expect(Math.abs(d.v[i] - t / d.total)).toBeLessThan(0.03));   // linear track
  expect(Math.abs(d.un.iIn - d.un.iOut) / d.un.iIn).toBeLessThan(0.005);                                // conserved
  expect(Math.abs(d.ld.iIn - d.ld.iOut - d.ld.iFix) / d.ld.iIn).toBeLessThan(0.005);                    // in = out + wiper
  expect(d.ld.v).toBeGreaterThan(0.37);                                                                  // 5k/5k with 10k load: 0.4
  expect(d.ld.v).toBeLessThan(0.43);
  expect(d.ld.iIn).toBeGreaterThan(d.ld.iOut * 1.3);                                                    // wiper draws current
  expect(d.R).toBeCloseTo(10000, -1);
  await shot(page, "pot_potential_mid");
  // the screw turns the drawn wiper: at 0 turns it points at the pin 3 end (lower left)
  const c0 = await page.evaluate(() => {
    const m = window.__app!.model!, g = m.byId.get("wiper")!.mesh.geometry;
    g.computeBoundingBox();
    const c = g.boundingBox!.getCenter(new window.THREE_NS!.Vector3());
    window.__app!.arcPhysics.setTurns(0);
    g.computeBoundingBox();
    const c2 = g.boundingBox!.getCenter(new window.THREE_NS!.Vector3());
    return { before: c.toArray(), after: c2.toArray() };
  });
  expect(c0.after[0]).toBeLessThan(c0.before[0] - 0.5);
  expect(c0.after[2]).toBeLessThan(c0.before[2] - 0.5);
  await page.waitForTimeout(800);
  await shot(page, "pot_turns_0");
  await page.evaluate(() => { const ph = window.__app!.arcPhysics; ph.setTurns(18); ph.setLoad({ loaded: true, loadLog: 3 }); ph.play(true); });
  await page.waitForTimeout(1200);
  await expect(page.locator("#physics-hud")).toContainText("leaves through the wiper");
  await shot(page, "pot_loaded_heat");
  expect(errors).toEqual([]);
});

test("potentiometer animated sequence reaches the current stage", async ({ page }) => {
  const errors = await open(page, `${POT}&preset=exterior&physics=play`);
  await expect(page.locator("#physics-hud .stage")).toContainText("Current follows", { timeout: 20_000 });
  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------- shielded axial inductor (axisymmetric)
const AXL = "component=axial_inductor_l11&variant=exaggerated&theme=dark";

test("axial inductor: axisymmetric L near the marked value, Ampère, shield keeps the field in", async ({ page }) => {
  const errors = await open(page, `${AXL}&preset=exterior&instant=1&physics=1`);
  const d = await page.evaluate(() => {
    const ind = window.__app!.indPhysics as any;
    const on = { r: ind.readout(), der: { ...ind.derived } };
    ind.setShield(false);
    const off = { r: ind.readout(), der: { ...ind.derived } };
    ind.setShield(true);
    return { on, off };
  });
  console.log("axial L shielded", (d.on.r.L2d * 1e6).toFixed(1), "uH, unshielded", (d.off.r.L2d * 1e6).toFixed(1),
    "uH | B outside", (d.on.der.bAbove * 1e3).toFixed(3), "vs", (d.off.der.bAbove * 1e3).toFixed(3), "mT/A | ferrite gain", d.on.r.bAirRatio.toFixed(1));
  expect(Math.abs(d.on.der.ampereLoop / d.on.der.ampereEnclosed - 1)).toBeLessThan(0.02);   // discrete Ampère
  expect(Math.abs(d.on.r.L2d / d.on.r.L0 - 1)).toBeLessThan(0.25);                          // solved L ≈ marked
  expect(d.off.r.L2d).toBeLessThan(d.on.r.L2d);                                             // the shield adds L ...
  expect(d.off.der.bAbove).toBeGreaterThan(2 * d.on.der.bAbove);                           // ... and keeps B inside
  expect(d.on.r.bAirRatio).toBeGreaterThan(1.5);
  await shot(page, "axial_field_shielded");
  await page.evaluate(() => (window.__app!.indPhysics as any).setShield(false));
  await shot(page, "axial_field_unshielded");
  expect(errors).toEqual([]);
});
