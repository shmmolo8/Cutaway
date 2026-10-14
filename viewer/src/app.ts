import * as THREE from "three";
import GUI, { type Controller } from "lil-gui";
import { loadIndex, loadVariant } from "./data";
import { InfoCard } from "./info";
import { ComponentModel } from "./model";
import { ComponentMenu } from "./menu";
import { LayerPanel } from "./panel";
import { pick } from "./picking";
import { PlatePhysics } from "./physics/capacitor";
import { ArcPhysics } from "./physics/arc";
import { ElectroPhysics } from "./physics/electrolytic";
import { HelixPhysics } from "./physics/helix";
import { CoilPhysics } from "./physics/inductor";
import { SheetPhysics } from "./physics/sheet";
import { SectionTool, type Axis } from "./section";
import type { IndexEntry, PresetMeta, Vec3 } from "./types";
import { easeInOut, Viewer } from "./viewer";
import { fmt } from "./format";

export interface AppState {
  component: string;
  variant: string;
  sectionOn: boolean;
  axis: Axis;
  offset: number;
  explode: number;
}

const HOVER_EMISSIVE = new THREE.Color(0x5fb3ff).multiplyScalar(0.16);
const NO_EMISSIVE = new THREE.Color(0x000000);

/** Top-level wiring: loads components, owns GUI/panel/picking, exposes a test API. */
export class App {
  readonly viewer: Viewer;
  readonly gui: GUI;
  readonly section: SectionTool;
  index: IndexEntry[] = [];
  model: ComponentModel | null = null;
  readonly state: AppState = {
    component: "", variant: "exaggerated",
    sectionOn: false, axis: "Y", offset: 0,
    explode: 0,
  };
  hovered: string | null = null;
  selected: string | null = null;
  isolated: string | null = null;

  private instant = false;
  private offsetCtrl: Controller | null = null;
  private viewsFolder: GUI | null = null;
  private statusEl = document.getElementById("status")!;
  private panel: LayerPanel;
  private info: InfoCard;
  private menu: ComponentMenu | null = null;
  readonly physics: SheetPhysics;
  readonly capPhysics: PlatePhysics;
  readonly indPhysics: CoilPhysics;
  readonly helixPhysics: HelixPhysics;
  readonly elPhysics: ElectroPhysics;
  readonly arcPhysics: ArcPhysics;
  private physicsFolder: GUI | null = null;
  private hud = document.getElementById("physics-hud")!;
  private hudCollapsed = false;
  private savedVisibility: Map<string, boolean> | null = null;
  private explodeTween: { from: number; to: number; t: number; dur: number } | null = null;
  private pointer = { ndc: new THREE.Vector2(), pending: false, down: new THREE.Vector2(), inside: false, x: 0, y: 0 };
  private tip = document.getElementById("tip")!;

  constructor() {
    this.viewer = new Viewer(document.getElementById("viewport")!);
    this.gui = new GUI({ container: document.getElementById("gui")!, title: "Controls" });
    this.section = new SectionTool(this.viewer);
    this.section.onChange(() => this.syncSectionState());
    this.physics = new SheetPhysics(this.viewer, this.section);
    this.capPhysics = new PlatePhysics(this.viewer, this.section);
    this.indPhysics = new CoilPhysics(this.viewer, this.section);
    this.helixPhysics = new HelixPhysics(this.viewer, this.section);
    this.elPhysics = new ElectroPhysics(this.viewer, this.section);
    this.arcPhysics = new ArcPhysics(this.viewer, this.section);
    // physics reports changes every animation frame; the readout (DOM + layout) updates at
    // ~10 Hz with a trailing call, so the final state is always shown
    let lastHud = 0, pending: number | null = null;
    const refresh = () => {
      lastHud = performance.now();
      pending = null;
      this.renderHud();
      this.physicsFolder?.controllersRecursive().forEach((c) => c.updateDisplay());
    };
    this.physics.onChange = this.capPhysics.onChange = this.indPhysics.onChange = this.helixPhysics.onChange = this.elPhysics.onChange = this.arcPhysics.onChange = () => {
      const wait = 90 - (performance.now() - lastHud);
      if (wait <= 0) refresh();
      else if (pending === null) pending = window.setTimeout(refresh, wait);
    };
    // delegated: the HUD is re-rendered often, so bind once on the container
    this.hud.addEventListener("pointerdown", (e) => {
      if (!(e.target as HTMLElement).closest(".hud-toggle")) return;
      this.hudCollapsed = !this.hudCollapsed;
      this.renderHud();
    });
    this.panel = new LayerPanel(document.getElementById("layers")!, {
      onToggle: (id, v) => this.setLayerVisible(id, v),
      onIsolate: (id) => this.toggleIsolate(id),
      onShowAll: () => this.showAll(),
      onHover: (id) => this.setHover(id),
      onSelect: (id) => this.select(this.selected === id ? null : id),
    });
    this.info = new InfoCard(document.getElementById("info")!);
    this.info.onClose = () => this.select(null);
    this.viewer.onFrame((dt) => this.tick(dt));
    this.bindPointer();
    window.addEventListener("keydown", (e) => { if (e.key === "Escape") this.select(null); });
    this.initTheme();
  }

  // ------------------------------------------------------------------ theme
  private initTheme(): void {
    let stored: string | null = null;
    try { stored = localStorage.getItem("cutaway-theme"); } catch { /* storage unavailable */ }
    const param = new URLSearchParams(location.search).get("theme");
    const prefersLight = window.matchMedia?.("(prefers-color-scheme: light)").matches;
    this.setTheme((param ?? stored ?? (prefersLight ? "light" : "dark")) as "light" | "dark", false);
    document.getElementById("theme-btn")!.addEventListener("click", () =>
      this.setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light", true));
  }

  setTheme(theme: "light" | "dark", persist: boolean): void {
    document.documentElement.dataset.theme = theme;
    const btn = document.getElementById("theme-btn")!;
    const dark = theme === "light";                                 // the theme the button switches to
    btn.innerHTML = `<span class="icon">${dark ? "☾" : "☀"}</span><span class="label">${dark ? "Dark mode" : "Light mode"}</span>`;
    btn.title = theme === "light" ? "Switch to dark theme" : "Switch to light theme";
    if (persist) try { localStorage.setItem("cutaway-theme", theme); } catch { /* ignore */ }
    this.viewer.syncBackground();
    this.updateOutline();
  }

  /** Switch component from the menu (fresh view, URL updated). */
  async selectComponent(id: string): Promise<void> {
    if (id === this.state.component) return;
    this.state.component = id;
    await this.load({ keepView: false });
    this.applyPreset("exterior", { animate: false });
  }

  async start(): Promise<void> {
    const params = new URLSearchParams(location.search);
    this.instant = params.has("instant");
    this.index = await loadIndex();
    if (!this.index.length) throw new Error("build/index.json lists no components");
    const wanted = params.get("component");
    const entry = this.index.find((e) => e.id === wanted)
      ?? this.index.find((e) => e.id.endsWith("0603")) ?? this.index[0];
    this.state.component = entry.id;
    this.state.variant = params.get("variant") ?? entry.default_variant;
    this.menu = new ComponentMenu(this.index, (id) => void this.selectComponent(id));
    this.buildGui();
    await this.load({ keepView: false });
    this.applyPreset(params.get("preset") ?? "exterior", { animate: false });
    if (params.has("physics") && (this.physics.available || this.capPhysics.available || this.indPhysics.available
      || this.helixPhysics.available || this.elPhysics.available || this.arcPhysics.available))
      this.powerOn(params.get("physics") === "play");
    if (params.get("physics") === "ac") {                // ?physics=ac: start in AC mode (capacitors, inductors)
      if (this.capPhysics.available) this.capPhysics.setAc(true);
      else if (this.indPhysics.available) this.indPhysics.set("ac", true);
      this.reframePhysics();
      this.updateGui();
    }
  }

  private entry(): IndexEntry {
    return this.index.find((e) => e.id === this.state.component)!;
  }

  /**
   * Load the current component/variant. With keepView (scale toggle), the camera,
   * plane, explode, visibility and selection carry over, matched by layer id.
   */
  async load({ keepView }: { keepView: boolean }): Promise<void> {
    this.status("Loading…");
    const prevVisible = new Map(this.model?.layers.map((l) => [l.meta.id, l.visible]) ?? []);
    const stem = this.entry().variants[this.state.variant];
    const model = new ComponentModel(await loadVariant(stem));
    this.viewer.setModel(model);
    this.model = model;
    this.section.setModel(model);
    this.panel.build(model);
    this.physics.attach(model);
    this.capPhysics.attach(model);
    this.indPhysics.attach(model);
    this.helixPhysics.attach(model);
    this.elPhysics.attach(model);
    this.arcPhysics.attach(model);
    if (keepView) {
      for (const l of model.layers) model.setVisible(l.meta.id, prevVisible.get(l.meta.id) ?? true);
      model.setExplode(this.state.explode);
      if (this.selected && !model.byId.has(this.selected)) this.selected = null;
    } else {
      this.selected = this.hovered = this.isolated = null;
      this.savedVisibility = null;
      this.state.explode = 0;
      model.setExplode(0);
    }
    this.refreshLayers();
    this.select(this.selected);
    this.buildViews();
    this.buildPhysicsGui();
    this.menu?.setActive(this.entry());
    const url = new URL(location.href);
    url.searchParams.set("component", this.state.component);
    url.searchParams.set("variant", this.state.variant);
    history.replaceState(null, "", url);
    const badge = document.getElementById("variant-badge")!;
    badge.textContent = this.state.variant === "exaggerated" ? "Thin films exaggerated" : "True scale";
    badge.className = `badge ${this.state.variant}`;
    this.status("");
  }

  // ------------------------------------------------------------------ GUI
  private buildGui(): void {
    const c = this.gui.addFolder("Display");
    c.add(this.state, "variant", { "Exaggerated thin films": "exaggerated", "True scale": "true_scale" })
      .name("Scale").onChange(() => this.load({ keepView: true }));

    const s = this.gui.addFolder("Slice plane");
    s.add(this.state, "sectionOn").name("Enabled").onChange((v: boolean) => this.section.setEnabled(v));
    s.add(this.state, "axis", ["X", "Y", "Z"]).name("Axis").onChange((a: Axis) => {
      if (a !== "custom") this.section.setAxis(a, 0);
    });
    this.offsetCtrl = s.add(this.state, "offset", -1, 1, 0.001).name("Offset (mm)")
      .onChange((v: number) => this.section.setOffset(v));

    const e = this.gui.addFolder("Explode");
    e.add(this.state, "explode", 0, 1, 0.001).name("Amount").onChange((v: number) => {
      this.explodeTween = null;
      this.setExplode(v);
    });
    e.add({ animate: () => this.animateExplode() }, "animate").name("▶ Explode / collapse");

    this.viewsFolder = this.gui.addFolder("Views");
    if (window.matchMedia("(max-width: 760px)").matches) this.gui.close();
  }

  /** One button per metadata preset (rebuilt per component). */
  private buildViews(): void {
    const f = this.viewsFolder;
    if (!f || !this.model) return;
    [...f.controllers].forEach((ctrl) => ctrl.destroy());
    for (const p of this.model.meta.presets)
      f.add({ go: () => this.applyPreset(p.id) }, "go").name(p.label);
  }

  /** Mirror SectionTool state into the GUI (after presets, gizmo drags, ...). */
  private syncSectionState(): void {
    this.updateOutline();
    const sec = this.section;
    Object.assign(this.state, {
      sectionOn: sec.enabled, axis: sec.axis, offset: +sec.offset.toFixed(4),
    });
    if (this.offsetCtrl) {
      const r = Math.ceil(sec.offsetRange() * 1000) / 1000;
      this.offsetCtrl.min(-r).max(r);
    }
    this.updateGui();
  }

  private updateGui(): void {
    this.gui.controllersRecursive().forEach((c) => c.updateDisplay());
  }

  // ------------------------------------------------------------------ presets
  preset(id: string): PresetMeta | undefined {
    return this.model?.meta.presets.find((p) => p.id === id);
  }

  applyPreset(id: string, opts: { animate?: boolean } = {}): void {
    const model = this.model;
    const p = this.preset(id);
    if (!model || !p) return;
    const animate = (opts.animate ?? true) && !this.instant;
    if (p.plane) {
      this.section.setFromMeta(p.plane);
      this.section.setEnabled(true);
    } else {
      this.section.setEnabled(false);
    }
    // presets start from a clean slate: everything visible except what the preset hides
    this.showAll();
    for (const id of p.hide ?? []) model.setVisible(id, false);
    this.refreshLayers();
    this.animateExplode(p.explode, animate);
    const box = p.explode > 0 ? model.boxAtExplode(p.explode) : model.worldBox();
    this.viewer.frameBox(box, model.cadDirToWorld(p.camera.direction), { animate, margin: p.camera.fit === "section" ? 1.08 : 1.15 });
  }

  // ------------------------------------------------------------------ physics
  /** Turn the physics view on: collapse, clear the section, frame the film, optionally play. */
  powerOn(play: boolean): void {
    const m = this.model, cap = this.capPhysics, ind = this.indPhysics, el = this.elPhysics;
    if (m && el.meta) {
      // the winding is seen in the horizontal section
      this.animateExplode(0, !this.instant);
      this.showAll();
      this.section.setFromMeta(el.meta.plane);
      this.section.setEnabled(true);
      if (play) el.play(this.instant); else el.setOn(true);
      this.reframePhysics();
      this.updateGui();
      return;
    }
    if (m && ind.meta) {
      this.animateExplode(0, !this.instant);
      this.showAll();
      this.section.setFromMeta(ind.meta.plane);
      this.section.setEnabled(true);
      if (play) ind.play(this.instant); else ind.setOn(true);
      this.reframePhysics();
      this.updateGui();
      return;
    }
    if (m && cap.meta) {
      // the capacitor's field lives in the longitudinal section: cut there and look at it
      this.animateExplode(0, !this.instant);
      this.showAll();
      this.section.setFromMeta(cap.meta.plane);
      this.section.setEnabled(true);
      if (play) cap.play(this.instant); else cap.setOn(true);
      this.renderHud();
      const fit = cap.meta.camera.box;
      const box = fit ? new THREE.Box3().setFromPoints(fit.map((p) => m.cadPointToWorld(p))) : m.worldBox();
      this.viewer.frameBox(box, m.cadDirToWorld(cap.meta.camera.direction), { animate: !this.instant, margin: 1.02 });
      this.updateGui();
      return;
    }
    const ph = this.physics.meta ? this.physics : this.helixPhysics.meta ? this.helixPhysics
      : this.arcPhysics.meta ? this.arcPhysics : null;
    if (!m || !ph?.meta) return;
    this.animateExplode(0, !this.instant);
    if (play) ph.play(this.instant); else ph.setOn(true);
    this.reframePhysics();
    this.updateGui();
  }

  /** Re-fit the part above the readout panel (its height changes with the mode). */
  reframePhysics(): void {
    const m = this.model;
    const cam = this.indPhysics.meta?.camera ?? this.capPhysics.meta?.camera ?? this.physics.meta?.camera
      ?? this.helixPhysics.meta?.camera ?? this.elPhysics.meta?.camera ?? this.arcPhysics.meta?.camera;
    if (!m || !cam) return;
    this.renderHud();
    // a physics camera may name the part of the model to frame (the body, not its long leads)
    const fit = (cam as { box?: Vec3[] }).box;
    const box = fit ? new THREE.Box3().setFromPoints(fit.map((p) => m.cadPointToWorld(p))) : m.worldBox();
    const d = this.indPhysics.meta?.domain;
    if (d) {                                        // include the air where field lines return
      box.expandByPoint(m.cadPointToWorld([d[0][0], 0, d[0][1]]));
      box.expandByPoint(m.cadPointToWorld([d[1][0], 0, d[1][1]]));
    }
    this.viewer.frameBox(box, m.cadDirToWorld(cam.direction), { animate: !this.instant, margin: this.physics.meta ? 1.05 : 1.0 });
  }

  private buildPhysicsGui(): void {
    this.physicsFolder?.destroy();
    this.physicsFolder = null;
    const ph = this.physics, cap = this.capPhysics, ind = this.indPhysics;
    if (ind.meta) {
      const f = this.gui.addFolder("Physics: current & magnetic field");
      const s = ind.state, e = ind.meta.electrical;
      f.add({ play: () => this.powerOn(true) }, "play").name("▶ Energize (animated)");
      f.add(s, "on").name("Powered").onChange((v: boolean) => (v ? this.powerOn(false) : ind.setOn(false)));
      f.add(s, "ac", { "DC": false, "AC (sine)": true }).name("Supply")
        .onChange((v: boolean) => { if (!s.on) this.powerOn(false); ind.set("ac", v); this.reframePhysics(); });
      f.add(s, "current", 0, 3 * e.rated_current_a, 0.005).name("DC current (A)").onChange((v: number) => ind.set("current", v));
      f.add(s, "acAmp", 0.001, 2 * e.rated_current_a, 0.001).name("AC amplitude (A)").onChange((v: number) => ind.set("acAmp", v));
      const freq = f.add(s, "freqLog", 1, 9, 0.01).name("AC frequency");
      const label = document.createElement("span");
      label.className = "freq-label";
      freq.$widget.append(label);
      const upd = () => { label.textContent = fmt(10 ** s.freqLog, "Hz"); };
      freq.onChange((v: number) => { ind.set("freqLog", v); upd(); }); upd();
      f.add(s, "core").name("Show ferrite (off: see the coil)").onChange((v: boolean) => { ind.set("core", v); this.refreshLayers(); });
      if (ind.meta.ferrite?.some((r) => r.group === "shield"))
        f.add(s, "shield").name("Shield sleeve (off: unshielded)").onChange((v: boolean) => { ind.setShield(v); this.refreshLayers(); });
      f.add(s, "field").name("Flux density |B|").onChange((v: boolean) => ind.set("field", v));
      f.add(s, "fieldLines").name("Field lines").onChange((v: boolean) => ind.set("fieldLines", v));
      f.add(s, "flow").name("Flux flow markers").onChange((v: boolean) => ind.set("flow", v));
      f.add(s, "coilCurrent").name("Coil current").onChange((v: boolean) => ind.set("coilCurrent", v));
      f.add(s, "induced").name("Induced E (−∂A/∂t)").onChange((v: boolean) => ind.set("induced", v));
      f.add(s, "paused").name("Pause AC").onChange((v: boolean) => ind.set("paused", v));
      f.add(s, "phaseDeg", 0, 360, 1).name("AC phase (°)").onChange((v: number) => { s.paused = true; ind.set("phaseDeg", v); });
      this.gui.$children.insertBefore(f.domElement, this.viewsFolder!.domElement);
      this.physicsFolder = f;
      this.renderHud();
      return;
    }
    if (cap.meta) {
      const f = this.gui.addFolder("Physics: charge & field");
      const s = cap.state;
      f.add({ play: () => this.powerOn(true) }, "play").name("▶ Charge it (animated)");
      f.add(s, "on").name("Powered").onChange((v: boolean) => (v ? this.powerOn(false) : cap.setOn(false)));
      f.add(s, "ac", { "DC": false, "AC (sine)": true }).name("Supply")
        .onChange((v: boolean) => { if (!s.on) this.powerOn(false); cap.setAc(v); this.reframePhysics(); });
      f.add(s, "voltage", 0, cap.meta.electrical.rated_voltage_v, 0.5).name("DC voltage (V)")
        .onChange((v: number) => cap.set("voltage", v));
      f.add(s, "acAmp", 0.01, 5, 0.01).name("AC amplitude (V)").onChange((v: number) => cap.set("acAmp", v));
      const freq = f.add(s, "freqLog", 1, 9, 0.01).name("AC frequency")
        .onChange((v: number) => cap.set("freqLog", v));
      // show the frequency in Hz next to the log slider
      const label = document.createElement("span");
      label.className = "freq-label";
      freq.$widget.append(label);
      const upd = () => { label.textContent = fmt(10 ** s.freqLog, "Hz"); };
      freq.onFinishChange(upd); freq.onChange((v: number) => { cap.set("freqLog", v); upd(); }); upd();
      f.add(s, "displacement").name("Show displacement current").onChange((v: boolean) => cap.set("displacement", v));
      f.add(s, "paused").name("Pause AC").onChange((v: boolean) => cap.set("paused", v));
      f.add(s, "phaseDeg", 0, 360, 1).name("AC phase (°)").onChange((v: number) => {
        s.paused = true;
        cap.set("phaseDeg", v);
      });
      f.add(s, "potential").name("Potential (red → black)").onChange((v: boolean) => cap.set("potential", v));
      f.add(s, "lines").name("Equipotential lines").onChange((v: boolean) => cap.set("lines", v));
      f.add(s, "strength").name("Field strength |E|").onChange((v: boolean) => cap.set("strength", v));
      f.add(s, "fieldLines").name("Field lines").onChange((v: boolean) => cap.set("fieldLines", v));
      f.add(s, "charges").name("Plate charge").onChange((v: boolean) => cap.set("charges", v));
      f.add(s, "dipoles").name("BaTiO₃ dipoles").onChange((v: boolean) => cap.set("dipoles", v));
      if (cap.meta.plate_shape === "disc") {
        // what-if design: C = eps0 eps_r A / d (the 3D field keeps showing the part as built)
        // design sliders reshape the plates and ceramic and re-solve the field
        const d = cap.meta.electrical.real_part.dielectric_um, upd = () => cap.redesign();
        f.add(s, "designD", 50, 1000, 5).name("Ceramic thickness d (µm)").onChange(upd);
        f.add(s, "designDia", 1, 2 * cap.meta.domain[1][0] * 0.98, 0.05).name("Electrode Ø (mm)").onChange(upd);
        f.add(s, "designEps", 5, 15000, 5).name("εr of the ceramic").onChange(upd);
        f.add({ reset: () => {
          const b = cap.meta!.electrical;
          Object.assign(s, { designD: d, designDia: b.electrode_diameter_mm ?? s.designDia, designEps: b.epsilon_r });
          f.controllersRecursive().forEach((c) => c.updateDisplay());
          upd();
        } }, "reset").name("↺ Back to the real part");
      }
      this.gui.$children.insertBefore(f.domElement, this.viewsFolder!.domElement);
      this.physicsFolder = f;
      this.renderHud();
      return;
    }
    if (this.arcPhysics.meta) {
      const f = this.gui.addFolder("Physics: voltage divider");
      this.arcPhysics.buildGui(f, (play) => this.powerOn(play));
      this.gui.$children.insertBefore(f.domElement, this.viewsFolder!.domElement);
      this.physicsFolder = f;
      this.renderHud();
      return;
    }
    if (this.elPhysics.meta) {
      const f = this.gui.addFolder("Physics: charge & oxide field");
      this.elPhysics.buildGui(f, (play) => this.powerOn(play));
      this.gui.$children.insertBefore(f.domElement, this.viewsFolder!.domElement);
      this.physicsFolder = f;
      this.renderHud();
      return;
    }
    if (this.helixPhysics.meta) {
      const f = this.gui.addFolder("Physics: current & heat");
      this.helixPhysics.buildGui(f, (play) => this.powerOn(play));
      this.gui.$children.insertBefore(f.domElement, this.viewsFolder!.domElement);
      this.physicsFolder = f;
      this.renderHud();
      return;
    }
    if (!ph.meta) {
      this.renderHud();
      return;
    }
    const f = this.gui.addFolder("Physics: current & heat");
    const s = ph.state;
    const e = ph.meta.electrical;
    f.add({ play: () => this.powerOn(true) }, "play").name("▶ Power on (animated)");
    f.add(s, "on").name("Powered").onChange((v: boolean) => (v ? this.powerOn(false) : ph.setOn(false)));
    f.add(s, "voltage", 0.5, e.max_working_voltage_v, 0.5).name("Voltage (V)")
      .onChange((v: number) => ph.set("voltage", v));
    f.add(s, "trim", 0, ph.maxTrimPct(), 1).name("Laser trim (%)").onChange((v: number) => ph.setTrim(v));
    f.add(s, "potential").name("Potential (red → black)").onChange((v: boolean) => ph.set("potential", v));
    f.add(s, "lines").name("Equipotential lines").onChange((v: boolean) => ph.set("lines", v));
    f.add(s, "current").name("Current flow").onChange((v: boolean) => ph.set("current", v));
    f.add(s, "heat").name("Heat (J²/σ)").onChange((v: boolean) => ph.set("heat", v));
    f.add(s, "electrons").name("Show electron drift").onChange((v: boolean) => ph.set("electrons", v));
    // keep the physics folder next to the views
    this.gui.$children.insertBefore(f.domElement, this.viewsFolder!.domElement);
    this.physicsFolder = f;
    this.renderHud();
  }

  private renderHud(): void {
    if (this.indPhysics.meta) {
      this.renderIndHud();
      return;
    }
    if (this.capPhysics.meta) {
      this.renderCapHud();
      return;
    }
    const elHtml = this.elPhysics.meta ? this.elPhysics.hudHtml() : this.arcPhysics.meta ? this.arcPhysics.hudHtml() : undefined;
    if (elHtml !== undefined) {
      if (!elHtml) {
        this.hud.hidden = true;
        this.syncInset();
        return;
      }
      this.hud.innerHTML = this.hudToggle() + elHtml;
      this.bindHud();
      return;
    }
    if (this.helixPhysics.meta) {
      const html = this.helixPhysics.hudHtml();
      if (!html) {
        this.hud.hidden = true;
        this.syncInset();
        return;
      }
      this.hud.innerHTML = this.hudToggle() + html;
      this.bindHud();
      return;
    }
    const r = this.physics.readout();
    const s = this.physics.state;
    if (!r || !s.on) {
      this.hud.hidden = true;
      this.syncInset();
      return;
    }
    const pct = (100 * r.P) / r.rated;
    this.hud.innerHTML = this.hudToggle() + `<div class="col">
      <div class="nums">
        <div><span>Voltage</span><b>${fmt(r.V, "V")}</b></div>
        <div><span>Current</span><b>${fmt(r.I, "A")}</b></div>
        <div class="${pct > 100 ? "over" : ""}"><span>Power (${pct.toFixed(0)}% of ${fmt(r.rated, "W")})</span><b>${fmt(r.P, "W")}</b></div>
        <div><span>Resistance</span><b>${fmt(r.R, "Ω")}</b></div>
      </div>
      ${r.stage ? `<div class="stage">${r.stage}</div>` : ""}</div>
      <div class="col details">
      <div class="note">Trim ${r.trim.toFixed(0)}% → R is ${((100 * r.R) / r.R0 - 100).toFixed(0)}% above the untrimmed film (${fmt(r.R0, "Ω")}).
        ${s.electrons ? "Showing electron drift (opposite to current). Real drift is ~µm/s: particle speed shows current density, not electron speed." : "Particles show conventional current, + → −; speed ∝ current density."}</div>
      </div><div class="col">
      ${s.heat ? `<div class="legend">cool<div class="bar" style="background:linear-gradient(90deg,#1a0c08,#8a1400,#ff6a00,#ffd23f,#fffbe6)"></div>hot</div>` : `<div class="legend">0 V<div class="bar" style="background:linear-gradient(90deg,#0b0b0c,#e0302a)"></div>+V</div>`}
      <div class="note">Film potential, current and heat are solved (∇·σ∇V = 0 on the film). Heat spreading into the body is illustrative.</div>
      </div>`;
    this.bindHud();
  }

  private renderCapHud(): void {
    const cap = this.capPhysics, r = cap.readout(), s = cap.state, m = cap.meta!;
    if (!r || !s.on) {
      this.hud.hidden = true;
      this.syncInset();
      return;
    }
    if (s.ac) {
      this.renderAcHud();
      return;
    }
    // charging curve (RC): i(t) = e^(-t/τ), v(t) = 1 - e^(-t/τ); cursor follows the sequence
    const pts = (f: (t: number) => number) => Array.from({ length: 41 }, (_, i) => {
      const t = (i / 40) * 5;
      return `${(t / 5) * 150},${38 - f(t) * 34}`;
    }).join(" ");
    const cursor = r.tNorm !== null ? Math.min(150, (r.tNorm / 5) * 150) : null;
    const graph = r.tNorm !== null ? `
      <svg class="chart" viewBox="-2 0 154 42" width="100%" height="46" aria-label="Charging current and voltage">
        <polyline points="${pts((t) => Math.exp(-t))}" fill="none" stroke="#ffb347" stroke-width="1.5"/>
        <polyline points="${pts((t) => 1 - Math.exp(-t))}" fill="none" stroke="#58b4ff" stroke-width="1.5"/>
        ${cursor !== null ? `<line x1="${cursor}" x2="${cursor}" y1="2" y2="40" stroke="currentColor" stroke-opacity="0.5"/>` : ""}
      </svg>
      <div class="legend"><span style="color:#ffb347">■</span> charging current <span style="color:#58b4ff">■</span> plate voltage (time in RC units)</div>` : "";
    const ov = (m.overlap.x[1] - m.overlap.x[0]) * 1e-3, w = m.electrode_width * 1e-3;
    const perGap = (8.854e-12 * r.epsR * ov * w) / (r.dReal * 1e-6);
    const realGaps = Math.round(r.Creal / perGap);
    this.hud.innerHTML = this.hudToggle() + `<div class="col">
      <div class="nums">
        <div><span>Voltage</span><b>${fmt(r.V, "V")}</b></div>
        <div><span>C (this model)</span><b>${fmt(r.C, "F")}</b></div>
        <div><span>Charge Q = CV</span><b>${fmt(r.Q, "C")}</b></div>
        <div><span>Energy ½CV²</span><b>${fmt(r.W, "J")}</b></div>
      </div>
      ${r.stage ? `<div class="stage">${r.stage}</div>` : ""}</div>
      <div class="col">${graph}
      ${s.strength ? `<div class="legend">weak<div class="bar" style="background:linear-gradient(90deg,#03030a,#1f0550,#1a5cff,#62e6ff,#f2ffff)"></div>strong |E|</div>` : `<div class="legend">0 V<div class="bar" style="background:linear-gradient(90deg,#0b0b0c,#e0302a)"></div>+V</div>`}</div>
      ${m.plate_shape === "disc" ? this.discNotes(r) : `<div class="col details">
      <div class="note">Solved C is ${((100 * r.C) / r.Cideal - 100).toFixed(1)}% above the ideal parallel-plate value
        εr·ε₀·A/d × ${r.gaps} gaps (${fmt(r.Cideal, "F")}); the excess is fringing at the plate tips.</div>
      <div class="note">A real 0603 ${fmt(r.Creal, "F")} part uses the same formula with ~${realGaps} gaps of ${r.dReal} µm
        (this model shows ${r.gaps} gaps of ${r.gapUm.toFixed(0)} µm). At ${fmt(r.V, "V")} its ceramic sees
        ${r.Ereal.toFixed(1)} V/µm, and X7R keeps only ~${(100 * r.biasFactor).toFixed(0)}% of εr → ≈ ${fmt(r.CrealBias, "F")} (DC-bias effect, typical curve).</div>
      <div class="note">Field solved in the longitudinal section (∇·ε∇V = 0) and extended across the plate width.</div>
      </div>`}`;
    this.bindHud();
  }

  /** Disc capacitor: C from its plate area and thickness, and the what-if design sliders. */
  private discNotes(r: NonNullable<ReturnType<PlatePhysics["readout"]>>): string {
    const s = this.capPhysics.state, m = this.capPhysics.meta!;
    const dia = m.overlap.x[1] - m.overlap.x[0];
    const cls = s.designEps < 150 ? "class 1 (C0G/NP0: stable, low εr)" : s.designEps < 5000 ? "class 2 (X7R-type)" : "class 2 high-K (Y5V/Z5U-type)";
    const ratio = r.C / r.Creal;
    return `<div class="col details">
      <div class="note">C = ε₀·εr·A/d: plates Ø ${dia.toFixed(2)} mm (A = ${(Math.PI * (dia / 2) ** 2).toFixed(1)} mm²), d = ${s.designD.toFixed(0)} µm,
        εr ${s.designEps.toFixed(0)} (${cls}) → ${fmt(r.Cideal, "F")} ideal; the solved field adds ${(100 * (r.fringe - 1)).toFixed(1)}%
        of fringing at the plate rims → <b>${fmt(r.C, "F")}</b>${Math.abs(ratio - 1) > 0.02 ? ` (${ratio >= 1 ? "×" + ratio.toPrecision(3) : "÷" + (1 / ratio).toPrecision(3)} the real part's ${fmt(r.Creal, "F")})` : ` (the real part: ${fmt(r.Creal, "F")})`}.</div>
      <div class="note">Field E = V/d = ${r.Edesign.toFixed(2)} V/µm${r.Edesign > 5 ? " — beyond typical breakdown strength of BaTiO₃ (~5 V/µm, typical)" : ""};
        plate charge σ = ε·E (glyph size), polarisation ∝ (εr − 1)·E (dipole length).</div>
      <div class="note">The sliders reshape the plates and ceramic and the field is re-solved (∇·ε∇V = 0 in the horizontal
        mid-section; C uses the disc area with that section's fringing). Drawn thickness keeps the view's exaggeration.</div>
      </div>`;
  }

  private renderAcHud(): void {
    const a = this.capPhysics.readoutAc()!, s = this.capPhysics.state;
    const W = 150, H = 44;
    // waveforms over two cycles; current leads voltage by -phase(Z)
    const lead = (-a.phaseDeg * Math.PI) / 180;
    const wave = (fn: (t: number) => number) => Array.from({ length: 81 }, (_, i) => {
      const t = (i / 80) * 4 * Math.PI;
      return `${((i / 80) * W).toFixed(1)},${(H / 2 - fn(t) * (H / 2 - 3)).toFixed(1)}`;
    }).join(" ");
    const cur = ((a.theta % (2 * Math.PI)) / (4 * Math.PI)) * W;
    // |Z| vs f, log-log: 10 Hz..1 GHz, 1 mOhm..100 kOhm
    const zx = (lf: number) => ((lf - 1) / 8) * W, zy = (z: number) => H - 2 - ((Math.log10(z) + 3) / 8) * (H - 4);
    const e = this.capPhysics.meta!.electrical;
    const zAt = (lf: number, real: boolean) => {
      const w = 2 * Math.PI * 10 ** lf, C = e.real_part.capacitance_f;
      return real ? Math.hypot(e.ac.esr_ohm, w * e.ac.esl_h - 1 / (w * C)) : 1 / (w * C);
    };
    const zline = (real: boolean) => Array.from({ length: 121 }, (_, i) => {
      const lf = 1 + (i / 120) * 8;
      return `${zx(lf).toFixed(1)},${Math.min(H, Math.max(0, zy(zAt(lf, real)))).toFixed(1)}`;
    }).join(" ");
    const lf = Math.log10(a.f);
    const inductive = a.phaseDeg > 0;
    const dB = 20 * Math.log10(a.atten);
    this.hud.innerHTML = this.hudToggle() + `<div class="col">
      <div class="nums">
        <div><span>AC peak</span><b>${fmt(a.V0, "V")}</b></div>
        <div><span>Frequency</span><b>${fmt(a.f, "Hz")}</b></div>
        <div><span>Impedance |Z|</span><b>${fmt(a.Z, "Ω")}</b></div>
        <div><span>Current peak</span><b>${fmt(a.Iamp, "A")}</b></div>
      </div>
      <div class="stage">${a.caption}</div></div>
      <div class="col">
      <svg class="chart" viewBox="-2 0 ${W + 4} ${H}" width="100%" height="${H + 4}" aria-label="Voltage and current waveforms">
        <line x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}" stroke="currentColor" stroke-opacity="0.25"/>
        <polyline points="${wave((t) => Math.sin(t))}" fill="none" stroke="#58b4ff" stroke-width="1.5"/>
        <polyline points="${wave((t) => Math.sin(t + lead))}" fill="none" stroke="#ffb347" stroke-width="1.5"/>
        <line x1="${cur}" x2="${cur}" y1="1" y2="${H - 1}" stroke="currentColor" stroke-opacity="0.6"/>
      </svg>
      <div class="legend"><span style="color:#58b4ff">■</span> voltage <span style="color:#ffb347">■</span> current
        (${inductive ? "lags" : "leads"} by ${Math.abs(a.phaseDeg).toFixed(0)}°) · shown slowed down</div>
      <svg class="chart" viewBox="-2 0 ${W + 4} ${H}" width="100%" height="${H + 4}" aria-label="Impedance versus frequency">
        <polyline points="${zline(false)}" fill="none" stroke="currentColor" stroke-opacity="0.45" stroke-dasharray="3 2"/>
        <polyline points="${zline(true)}" fill="none" stroke="#7fdc8f" stroke-width="1.5"/>
        <line x1="${zx(Math.log10(a.srf))}" x2="${zx(Math.log10(a.srf))}" y1="0" y2="${H}" stroke="#7fdc8f" stroke-opacity="0.35"/>
        <circle cx="${zx(lf)}" cy="${Math.min(H, Math.max(0, zy(a.Z)))}" r="2.6" fill="#fff"/>
      </svg>
      <div class="legend">|Z| from 10 Hz to 1 GHz: <span style="color:#7fdc8f">■</span> real part (ESR ${fmt(a.esr, "Ω")}, ESL ${fmt(a.esl, "H")})
        vs dashed ideal 1/ωC · self-resonance ${fmt(a.srf, "Hz")}</div></div>
      <div class="col details">
      <div class="note">X<sub>C</sub> = 1/(2πfC) = ${fmt(a.Xc, "Ω")} for the real ${fmt(a.C, "F")} part.
        ${inductive ? `Above self-resonance its ESL dominates: it now behaves like an inductor and |Z| rises again.`
          : `The higher the frequency, the lower the impedance — which is why capacitors shunt fast noise to ground.`}</div>
      <div class="note">Filtering example: with ${fmt(a.rs, "Ω")} of supply/trace impedance, noise at ${fmt(a.f, "Hz")}
        reaches the chip at ${(100 * a.atten).toPrecision(2)}% (${dB.toFixed(0)} dB).</div>
      <div class="note">No charge crosses the ceramic. Current "flows through" as displacement current
        ε·∂E/∂t (peak ≈ ${fmt(a.Jd / 1e4, "A")}/cm² in the real part); ${(100 * a.polarFrac).toFixed(2)}% of it is BaTiO₃'s
        dipoles swinging back and forth.</div>
      <div class="legend">${s.displacement
        ? `small<div class="bar" style="background:linear-gradient(90deg,#03030a,#1f0550,#1a5cff,#62e6ff,#f2ffff)"></div>large ε·∂E/∂t`
        : `−V<div class="bar" style="background:linear-gradient(90deg,#2f7bff,#0b0b0c,#e0302a)"></div>+V`}</div>
      </div>`;
    this.bindHud();
  }

  private renderIndHud(): void {
    const ind = this.indPhysics, s = ind.state, r = ind.readout();
    if (!r || !s.on) {
      this.hud.hidden = true;
      this.syncInset();
      return;
    }
    const W = 150, H = 44;
    const magBar = `<div class="legend">weak<div class="bar" style="background:linear-gradient(90deg,#030504,#0a3a1c,#12a676,#c2f040,#fffff0)"></div>strong |B|</div>`;
    const eBar = `<div class="legend">−E<div class="bar" style="background:linear-gradient(90deg,#2f7bff,#0b0b0c,#e0302a)"></div>+E (induced, into/out of the page)</div>`;
    if (s.ac) {
      const a = ind.readoutAc()!;
      const lead = (a.phaseDeg * Math.PI) / 180;                       // voltage leads current
      const wave = (fn: (t: number) => number) => Array.from({ length: 81 }, (_, i) => {
        const t = (i / 80) * 4 * Math.PI;
        return `${((i / 80) * W).toFixed(1)},${(H / 2 - fn(t) * (H / 2 - 3)).toFixed(1)}`;
      }).join(" ");
      const cur = ((a.theta % (2 * Math.PI)) / (4 * Math.PI)) * W;
      const e = ind.meta!.electrical;
      const zAt = (lf: number, real: boolean) => {
        const w = 2 * Math.PI * 10 ** lf;
        if (!real) return w * e.inductance_h;
        const zr = e.dcr_ohm, zi = w * e.inductance_h, yr = zr / (zr * zr + zi * zi), yi = -zi / (zr * zr + zi * zi) + w * e.parasitic_c_f;
        return 1 / Math.hypot(yr, yi);
      };
      const zx = (lf: number) => ((lf - 1) / 8) * W, zy = (z: number) => H - 2 - ((Math.log10(z) + 3) / 8) * (H - 4);
      const zline = (real: boolean) => Array.from({ length: 121 }, (_, i) => {
        const lf = 1 + (i / 120) * 8;
        return `${zx(lf).toFixed(1)},${Math.min(H, Math.max(0, zy(zAt(lf, real)))).toFixed(1)}`;
      }).join(" ");
      const capacitive = a.phaseDeg < 0;
      this.hud.innerHTML = this.hudToggle() + `<div class="col">
        <div class="nums">
          <div><span>AC current peak</span><b>${fmt(a.I0, "A")}</b></div>
          <div><span>Frequency</span><b>${fmt(a.f, "Hz")}</b></div>
          <div><span>Impedance |Z|</span><b>${fmt(a.Z, "Ω")}</b></div>
          <div><span>Voltage peak</span><b>${fmt(a.V0, "V")}</b></div>
        </div>
        <div class="stage">${a.caption}</div></div>
        <div class="col">
        <svg class="chart" viewBox="-2 0 ${W + 4} ${H}" width="100%" height="${H + 4}" aria-label="Voltage and current waveforms">
          <line x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}" stroke="currentColor" stroke-opacity="0.25"/>
          <polyline points="${wave((t) => Math.sin(t))}" fill="none" stroke="#ffb347" stroke-width="1.5"/>
          <polyline points="${wave((t) => Math.sin(t + lead))}" fill="none" stroke="#58b4ff" stroke-width="1.5"/>
          <line x1="${cur}" x2="${cur}" y1="1" y2="${H - 1}" stroke="currentColor" stroke-opacity="0.6"/>
        </svg>
        <div class="legend"><span style="color:#ffb347">■</span> current <span style="color:#58b4ff">■</span> voltage
          (${capacitive ? "lags" : "leads"} by ${Math.abs(a.phaseDeg).toFixed(0)}°) · shown slowed down</div>
        <svg class="chart" viewBox="-2 0 ${W + 4} ${H}" width="100%" height="${H + 4}" aria-label="Impedance versus frequency">
          <polyline points="${zline(false)}" fill="none" stroke="currentColor" stroke-opacity="0.45" stroke-dasharray="3 2"/>
          <polyline points="${zline(true)}" fill="none" stroke="#7fdc8f" stroke-width="1.5"/>
          <line x1="${zx(Math.log10(a.srf))}" x2="${zx(Math.log10(a.srf))}" y1="0" y2="${H}" stroke="#7fdc8f" stroke-opacity="0.35"/>
          <circle cx="${zx(Math.log10(a.f))}" cy="${Math.min(H, Math.max(0, zy(a.Z)))}" r="2.6" fill="#fff"/>
        </svg>
        <div class="legend">|Z| 10 Hz–1 GHz: <span style="color:#7fdc8f">■</span> real part (R<sub>dc</sub> ${fmt(a.dcr, "Ω")},
          C<sub>par</sub> ${fmt(a.cpar, "F")}) vs dashed ideal ωL · self-resonance ${fmt(a.srf, "Hz")}</div></div>
        <div class="col details">
        <div class="note">X<sub>L</sub> = 2πfL = ${fmt(a.XL, "Ω")} for the real ${fmt(a.L, "H")} part.
          ${capacitive ? "Above self-resonance the turn-to-turn capacitance takes over and |Z| falls again."
            : "Impedance rises with frequency, so in series an inductor passes DC but blocks fast noise."}</div>
        <div class="note">Filter example: in series with a ${fmt(a.RL, "Ω")} load, noise at ${fmt(a.f, "Hz")} reaches the load at
          ${(100 * a.atten).toPrecision(2)}% (${(20 * Math.log10(a.atten)).toFixed(0)} dB).</div>
        <div class="note">The changing flux induces E = −∂A/∂t (toggle "Induced E"): that is the back-EMF, and in the ferrite it
          drives eddy currents — why a high-resistivity ferrite is used, and why chip ferrites turn lossy at high frequency.</div>
        ${s.induced ? eBar : magBar}
        <div class="note">Field solved in the section through the coil axis (∇·ν∇A = −J), with the coil treated as long across its width.</div>
        </div>`;
      this.bindHud();
      return;
    }
    const g = r.tNorm !== null ? `
      <svg class="chart" viewBox="-2 0 154 42" width="100%" height="46" aria-label="Energizing current and coil voltage">
        <polyline points="${Array.from({ length: 41 }, (_, i) => `${(i / 40) * 150},${38 - (1 - Math.exp(-(i / 40) * 5)) * 34}`).join(" ")}" fill="none" stroke="#ffb347" stroke-width="1.5"/>
        <polyline points="${Array.from({ length: 41 }, (_, i) => `${(i / 40) * 150},${38 - Math.exp(-(i / 40) * 5) * 34}`).join(" ")}" fill="none" stroke="#58b4ff" stroke-width="1.5"/>
        <line x1="${Math.min(150, (r.tNorm / 5) * 150)}" x2="${Math.min(150, (r.tNorm / 5) * 150)}" y1="2" y2="40" stroke="currentColor" stroke-opacity="0.5"/>
      </svg>
      <div class="legend"><span style="color:#ffb347">■</span> current <span style="color:#58b4ff">■</span> voltage across L (time in L/R units)</div>` : "";
    const over = r.I > r.rated;
    this.hud.innerHTML = this.hudToggle() + `<div class="col">
      <div class="nums">
        <div class="${over ? "over" : ""}"><span>Current (${((100 * r.I) / r.rated).toFixed(0)}% of rated)</span><b>${fmt(r.I, "A")}</b></div>
        <div><span>Inductance</span><b>${fmt(r.L, "H")}</b></div>
        <div><span>Energy ½LI²</span><b>${fmt(r.W, "J")}</b></div>
        <div><span>B in the coil (model)</span><b>${fmt(r.bWindow, "T")}</b></div>
      </div>
      ${r.stage ? `<div class="stage">${r.stage}</div>` : ""}</div>
      <div class="col">${g}${s.induced || (r.stage && r.tNorm !== null && r.tNorm < 3) ? eBar : magBar}
      <div class="note">DC drop across R<sub>dc</sub>: ${fmt(r.Vdrop, "V")} (${fmt(r.Ploss, "W")} lost). A steady current induces nothing:
        at DC the inductor is just a short, low-value resistor.</div></div>
      <div class="col details">
      <div class="note">The ferrite (μr ≈ ${r.muR}) raises B inside the coil ~${r.bAirRatio.toFixed(0)}× compared with an air core
        carrying the same ${r.turns}-turn current, and keeps most of the flux inside the part.</div>
      <div class="note">${r.sat < 0.97 ? `At ${fmt(r.I, "A")} the ferrite is starting to saturate: L has dropped to ${(100 * r.sat).toFixed(0)}%
        of ${fmt(r.L0, "H")} (typical curve, illustrative).` : r.axisym ? `Marked value ${fmt(r.L0, "H")}; the axisymmetric solve gives
        ${fmt(r.L2d, "H")} for ${r.turns} turns${r.hasShield && !r.shield ? " without the shield" : ""} (L = 2W/I², winding drawn as one block).`
        : `Datasheet value ${fmt(r.L0, "H")}; the section model estimates
        ${fmt(r.L2d, "H")} (2D approximation, coil treated as long across its width).`}</div>
      ${r.hasShield ? `<div class="note">${r.shield ? "Shielded" : "Unshielded"}: just outside the body B = ${fmt(r.bAbove, "T")}.
        ${r.shield ? "The sleeve carries the return flux, so little field reaches neighbouring parts — toggle it off to compare."
          : "Without the sleeve the return flux spreads through the air around the part, where it can couple into neighbours."}</div>` : ""}
      <div class="note">Field solved in the section through the coil axis (${r.axisym ? "axisymmetric: ψ = r·A, ∇·(ν/r)∇ψ = −J" : "∇·ν∇A = −J"},
        ν = 1/μr), including the surrounding air.</div>
      </div>`;
    this.bindHud();
  }

  private hudToggle(): string {
    return `<button class="icon-btn hud-toggle" aria-label="${this.hudCollapsed ? "Show details" : "Hide details"}">${this.hudCollapsed ? "▸" : "▾"}</button>`;
  }

  /** Stage captions stay visible when collapsed; the explanatory notes fold away. */
  private syncInset(): void {
    const desktop = window.matchMedia("(min-width: 761px)").matches;
    const on = !this.hud.hidden;
    document.getElementById("app")!.classList.toggle("physics-on", on);
    this.viewer.setInsetBottom(desktop && on ? this.hud.offsetHeight + 16 : 0);
  }

  private bindHud(): void {
    this.hud.classList.toggle("collapsed", this.hudCollapsed);
    this.hud.hidden = false;
    this.syncInset();
  }

  // ------------------------------------------------------------------ explode
  setExplode(t: number): void {
    this.state.explode = t;
    this.model?.setExplode(t);
    this.viewer.invalidate();
  }

  /** Tween to `target` (default: toggle between 0 and 1). */
  animateExplode(target?: number, animate = true): void {
    const to = target ?? (this.state.explode > 0.5 ? 0 : 1);
    if (!animate || this.instant) {
      this.explodeTween = null;
      this.setExplode(to);
      this.updateGui();
      return;
    }
    const dist = Math.abs(to - this.state.explode);
    if (dist < 1e-4) return;
    this.explodeTween = { from: this.state.explode, to, t: 0, dur: 0.4 + 1.2 * dist };
  }

  private tick(dt: number): boolean {
    let animating = false;
    if (this.explodeTween) {
      const tw = this.explodeTween;
      tw.t = Math.min(1, tw.t + dt / tw.dur);
      this.setExplode(tw.from + (tw.to - tw.from) * easeInOut(tw.t));
      if (tw.t >= 1) this.explodeTween = null;
      this.updateGui();
      animating = true;
    }
    if (this.pointer.pending) {
      this.pointer.pending = false;
      this.hoverFromPointer();
    }
    return animating;
  }

  // ------------------------------------------------------------------ layers
  setLayerVisible(id: string, visible: boolean): void {
    this.model?.setVisible(id, visible);
    if (this.isolated && id !== this.isolated) this.isolated = null;
    this.refreshLayers();
  }

  toggleIsolate(id: string): void {
    const m = this.model;
    if (!m) return;
    if (this.isolated === id) {
      for (const l of m.layers) m.setVisible(l.meta.id, this.savedVisibility?.get(l.meta.id) ?? true);
      this.isolated = null;
      this.savedVisibility = null;
    } else {
      if (!this.isolated) this.savedVisibility = new Map(m.layers.map((l) => [l.meta.id, l.visible]));
      for (const l of m.layers) m.setVisible(l.meta.id, l.meta.id === id);
      this.isolated = id;
    }
    this.refreshLayers();
  }

  showAll(): void {
    const m = this.model;
    if (!m) return;
    for (const l of m.layers) m.setVisible(l.meta.id, true);
    this.isolated = null;
    this.savedVisibility = null;
    this.refreshLayers();
  }

  private refreshLayers(): void {
    const m = this.model;
    if (!m) return;
    for (const l of m.layers) this.panel.update(l, this.isolated === l.meta.id);
    this.section.syncVisibility();
    this.applyHighlights();
  }

  setHover(id: string | null): void {
    if (id === this.hovered) return;
    this.hovered = id;
    this.panel.setHover(id);
    this.applyHighlights();
    this.viewer.renderer.domElement.style.cursor = id ? "pointer" : "";
  }

  select(id: string | null): void {
    this.selected = id;
    this.panel.setSelected(id);
    this.info.show(id ? this.model?.byId.get(id)?.meta ?? null : null, this.state.variant);
    this.applyHighlights();
  }

  private applyHighlights(): void {
    const m = this.model;
    if (!m) return;
    for (const l of m.layers) {
      const id = l.meta.id;
      // selection = outline only: any emissive tint swamps dark materials like RuO2
      const c = id === this.hovered ? HOVER_EMISSIVE : NO_EMISSIVE;
      l.material.emissive.copy(c);
      this.section.capMaterial(id)?.emissive.copy(c);
    }
    this.updateOutline();
    this.viewer.invalidate();
  }

  /** Accent edge outline on the selected layer (clipped like its surfaces). */
  private outline: THREE.LineSegments | null = null;
  private updateOutline(): void {
    const layer = this.selected ? this.model?.byId.get(this.selected) : undefined;
    if (this.outline && this.outline.parent !== layer?.mesh) {
      this.outline.removeFromParent();
      this.outline.geometry.dispose();
      (this.outline.material as THREE.Material).dispose();
      this.outline = null;
    }
    if (layer && !this.outline) {
      this.outline = new THREE.LineSegments(
        new THREE.EdgesGeometry(layer.mesh.geometry, 20),
        new THREE.LineBasicMaterial({ depthTest: true, transparent: true, opacity: 0.95 }),
      );
      this.outline.renderOrder = 20_000;
      this.outline.raycast = () => {};
      layer.mesh.add(this.outline);
    }
    if (this.outline) {
      const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
      (this.outline.material as THREE.LineBasicMaterial).color.set(accent || "#5fb3ff");
      (this.outline.material as THREE.LineBasicMaterial).clippingPlanes = this.section.enabled ? [this.section.plane] : [];
      (this.outline.material as THREE.Material).needsUpdate = true;
    }
  }

  // ------------------------------------------------------------------ picking
  private bindPointer(): void {
    const el = this.viewer.renderer.domElement;
    const toNdc = (e: PointerEvent, out: THREE.Vector2) => {
      const r = el.getBoundingClientRect();
      out.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    };
    el.addEventListener("pointermove", (e) => {
      toNdc(e, this.pointer.ndc);
      const r = el.getBoundingClientRect();
      this.pointer.x = e.clientX - r.left;
      this.pointer.y = e.clientY - r.top;
      this.pointer.inside = true;
      if (e.buttons === 0) this.pointer.pending = true;       // no hover picking while orbiting
      this.viewer.invalidate();
    });
    el.addEventListener("pointerleave", () => {
      this.pointer.inside = false;
      this.tip.hidden = true;
      this.setHover(null);
    });
    el.addEventListener("pointerdown", (e) => this.pointer.down.set(e.clientX, e.clientY));
    el.addEventListener("pointerup", (e) => {
      if (Math.hypot(e.clientX - this.pointer.down.x, e.clientY - this.pointer.down.y) > 4) return;
      toNdc(e, this.pointer.ndc);
      const id = this.pickAt(this.pointer.ndc);
      this.select(id === this.selected ? null : id);
    });
  }

  /** Layer id under an NDC position (ignores the clipped-away side; caps are pickable). */
  pickAt(ndc: THREE.Vector2): string | null {
    return this.pickDetail(ndc)?.id ?? null;
  }

  pickDetail(ndc: THREE.Vector2): { id: string; onCap: boolean; planeDistance: number } | null {
    if (!this.model) return null;
    const r = pick(ndc, this.viewer.camera, this.model, this.section);
    return r && { id: r.layer.meta.id, onCap: r.onCap, planeDistance: this.section.plane.distanceToPoint(r.point) };
  }

  private hoverFromPointer(): void {
    if (!this.pointer.inside) return;
    const hit = this.pickDetail(this.pointer.ndc);
    this.setHover(hit?.id ?? null);
    const layer = hit && this.model?.byId.get(hit.id);
    this.tip.hidden = !layer;
    if (layer) {
      this.tip.textContent = layer.meta.name + (hit.onCap ? " · section" : "");
      this.tip.style.left = `${this.pointer.x}px`;
      this.tip.style.top = `${this.pointer.y}px`;
    }
  }

  status(text: string, error = false): void {
    this.statusEl.textContent = text;
    this.statusEl.classList.toggle("error", error);
  }
}
