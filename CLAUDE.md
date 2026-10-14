# Cutaway — conventions

> Current status, done/next and user preferences: see `.claude/STATUS.md`.

Interactive 3D cross-section viewer for electronic components. Geometry is generated
in Python (build123d), exported as GLB + metadata JSON, and shown by a generic
three.js viewer with stencil-capped slice planes and exploded views.

## Pipeline

```
data/<family>_<size>.yaml ──> geometry/components/<family>.py ──> carve() ──> checks
        (numbers + text)            (construction logic)          (no overlap)
   ──> build/models/<id>_<variant>.{glb,json,step} + build/index.json ──> one viewer (menu)
```

`make all` runs export (generate + validate) → pytest → section previews → typecheck →
Playwright screenshots + contact sheets. `make dev` starts the viewer.
Python lives in `.venv` (`make setup`). Always run Python with `PYTHONPATH=.` or via make.

## Units and axes

- **Millimetres everywhere.** Layer thicknesses in YAML are in micrometres (`thickness_um`),
  lateral dimensions in mm. Viewer: 1 unit = 1 mm.
- **CAD frame (Z-up):** X = component length (terminals at ±X), Y = width, Z = up.
  Origin = footprint centre, z = 0 = PCB seating plane. This matches KiCad's 3D models,
  so bounding boxes compare directly with the reference STEP. Through-hole parts follow
  KiCad's THT convention instead: origin = pin 1 (axial resistor: body centred at x = pitch/2,
  axis at z = D/2).
- **GLB:** one root node named `<component id>` carrying a −90° X rotation (CAD Z-up →
  glTF Y-up). Layer nodes are its children and stay in CAD coordinates, so every vector
  in the metadata (explode directions, preset planes/cameras) is in the CAD frame and
  the viewer applies it in the root's local space.

## Naming

- Component id: `<family>_<size>` (e.g. `chip_resistor_0603`).
- Layer id: `snake_case` kind, plus `_L` / `_R` for the −X / +X instance
  (`tin_L`, `nickel_R`). GLB node name = mesh name = material name = metadata id.
- Layer *kind* = the id without the side suffix; kind is the key into the `layers:`
  descriptions of the parameter file.
- Build output: `build/models/<id>_<variant>.glb|.json|.step`; `build/index.json` lists
  all components (id, name, category, description, variants) and drives the viewer menu.
- One size per component family (0603). Other sizes share the construction, so they
  are not kept; a new size would be a new YAML only.
- Variants: `exaggerated` (viewer default) and `true_scale`.

## Geometry rules (must hold for every component)

1. **Every physical layer is its own closed, valid solid.** Left/right instances are
   separate solids so they can explode in opposite directions.
2. **No overlaps.** Never place a layer by hand-fitting coordinates. Describe its
   *envelope* and let `geometry.core.layers.carve()` subtract every earlier layer
   (placement order = inside-out). Neighbours then share faces only. Voids that a later
   layer should fill (e.g. laser-trim kerf) are `cuts=` on the earlier layers.
   Overlapping solids break the viewer's stencil caps.
3. **Section planes never lie on a face.** Preset planes go through
   `clear_plane()`; `tests/` enforces it.
4. **Exaggeration:** `t = max(t_true*factor, min_visible)`, capped at `max_um`, never
   below true. Only thicknesses are exaggerated, never lateral dimensions. Outer
   dimensions are fixed; the bulk body (substrate) absorbs the difference and must stay
   ≥ `min_substrate_fraction` of H.
5. Everything numeric comes from the parameter file (one self-contained YAML per
   component; `extends:` deep-merge is still supported). The viewer never needs
   component-specific code.
6. Exactly one layer per component is `derived=True` (the bulk: substrate, ceramic body);
   its thickness is whatever the films leave, and it must stay ≥ `min_substrate_fraction` of H.
7. Many identical features (e.g. MLCC inner electrodes) are one multi-solid layer per
   side (`allow_multiple_solids=True`), not one layer each — keeps the panel readable.
8. Reference STEPs (`Components/<Family>/…step`) are used only to validate the bounding
   box. Never import them as output geometry.

## Parameter files

`data/materials.yaml` — shared material library (`name, color, roughness, metalness, opacity`).
`data/<family>_<size>.yaml` — `component, generator, size, display_name, category,
description, reference_step, bbox_tolerance_mm, dimensions, thickness_um, exaggeration,
explode, tessellation, layers` + family-specific sections. Any YAML in `data/` with a
`generator:` key is a component and is picked up automatically by build, tests and viewer.
Each `layers.<kind>` entry: `name, material, function, explode: {direction, order}`.

## Metadata schema (`build/<family>/<size>_<variant>.json`, schema_version 1)

```jsonc
{
  "schema_version": 1,
  "component": {
    "id", "family", "size", "name", "category", "description", "variant",
    "variants": {"exaggerated": "<path stem>", "true_scale": "<path stem>"},
    "units": "mm", "up": "+Z", "frame": "...",
    "bbox": [[minx,miny,minz],[maxx,maxy,maxz]],
    "source": "data/....yaml",
    "levels": {"<name>": mm, ...}          // informative Z levels / X stations
  },
  "explode": {"step_mm": 0.12},             // displacement per explode-order unit
  "layers": [{                              // placement order (inside-out)
    "id", "kind", "name", "material", "function",
    "thickness_true_um", "thickness_model_um", "derived",
    "color": "#RRGGBB", "roughness", "metalness", "opacity",
    "group": "termination_L" | null,
    "volume_mm3",
    "explode": {"direction": [x,y,z], "order": int}
  }],
  "presets": [{
    "id", "label",
    "plane": {"normal": [x,y,z], "point": [x,y,z]} | null,   // keeps the side the normal points to
    "explode": 0..1,
    "hide": ["<layer id>", ...]?,                            // optional: layers hidden in this view
    "camera": {"direction": [x,y,z], "fit": "section"?}      // camera position direction from target
  }]
}
```

Explode semantics: offset = `direction × step_mm × order × p(t)`, where t is the slider
(0…1) and p is an eased per-layer progress that starts earlier for higher orders. Final
displacement scales with order and outer shells lead, so nested shells (tin over nickel
over NiCr) separate cleanly.

## Verification

- `make test` — pytest. `tests/test_geometry.py` runs the generic checks on every
  component (solids valid & closed, pairwise intersection ≈ 0, bbox vs KiCad STEP,
  meshes watertight/outward, thickness rules, GLB names = metadata ids, preset planes
  clear of faces). Family-specific checks live in `tests/test_<family>.py`.
- `make preview` — matplotlib 2D sections of each preset from the exported meshes.
- `make screenshots` — Playwright captures of every viewer preset in both variants
  (`.test-output/screenshots/`). Look at them before calling work done.

## Adding a component

1. `data/<family>_0603.yaml` (+ reference STEP in `Components/<Family>/`); add any new
   materials to `data/materials.yaml`.
2. `geometry/components/<family>.py` with `build(params, variant) -> Component`:
   `LayerSpec` envelopes (one `derived=True` bulk), `carve()`, presets (always include
   `exterior`, `longitudinal`, `exploded`), `clear_plane()` them.
3. `tests/test_<family>.py` for anything structural the generic tests can't know.
4. `make all`, then look at `.test-output/preview/` and `.test-output/screenshots/*_sheet.png`.
   The component appears in the viewer menu automatically.

Pitfalls already hit (don't repeat): build123d `geom_type` is an enum, not a string;
`Shape.intersect` may return a `ShapeList`; lil-gui 0.21 classes are `lil-*`; any
emissive tint swamps near-black materials; coplanar helper geometry z-fights caps.
Round parts: revolved circular arcs become tori, which OCC meshes with 2π/angular_deflection
segments in *both* directions (12k triangles per fillet) — draw 90° arcs as rational
quadratic Béziers (`Edge.make_bezier(..., weights=[1, √½, 1])`, see
`carbon_film_resistor._revolve`). Sub-µm films on curved faces need a fine
`angular_deflection` to pass the 0.1 % mesh-volume check. Wires (`no_thickness:` kinds in
the YAML) have null thickness and skip the exaggeration rule.
Swept wires: an S-bend's tightest radius must exceed the wire radius or the swept surface
folds (meshes with holes); keep booleans' faces off sweep seams (segment junctions); place a
wire *before* the solder/coat that should fill around it (carve order = who gets cut).
Windings / nm films: build spirals from semicircles about two alternating centres
(`aluminum_electrolytic_capacitor.spiral_strip`) — every offset is an exact concentric arc,
so even a 32 nm oxide carves and meshes cleanly (BSpline spirals would not).

## Viewer conventions (`viewer/src/`)

- **Generic:** everything comes from `build/index.json` and each variant's metadata. Never
  special-case a component id or layer id in viewer code.
- `model.ts` — `ComponentModel`: layer meshes by id, PBR materials from metadata,
  CAD↔world helpers (`cadDirToWorld`, `cadPointToWorld`), explode (final offset =
  direction × step × order; animation staggered so higher orders start first).
- `section.ts` — slice plane + stencil caps. Render order per layer i: stencil passes at
  `2i+1` (children of the layer mesh, so they follow explode), cap quad at `2i+2`
  (clears the stencil after drawing); surfaces at `RENDER_ORDER_SURFACE`. Caps are
  opaque even for translucent layers. The slice UI is only Enabled / Axis (X, Y, Z) / Offset;
  flip, the plane outline and the free-rotate gizmo were removed (no real use, cluttered the view).
- `picking.ts` — raycasts skip hits on the clipped-away side; cap faces are picked by
  intersecting the ray with the plane and a point-in-mesh parity test.
- Rendering is **on demand**: call `viewer.invalidate()` after any state change; frame
  callbacks return `true` while animating.
- Selection = edge outline only (emissive tints swamp dark materials like RuO2); hover =
  emissive tint.
- One page for every component: top-bar menu (`menu.ts`) from `index.json`; URL keeps
  `?component=&variant=` in sync (`&preset=`, `&theme=light|dark`, `&instant=1` also work).
- Theme: labelled pill button (icon + "Dark mode"/"Light mode") in the top bar; `html[data-theme]`, all colours are CSS variables (light overrides under
  `:root[data-theme="light"]`); `viewer.syncBackground()` reads `--viewport-bg`.
- Test API: `window.__app` (App), `window.__ready`, `window.THREE_NS`. Screenshot specs wait
  for `viewer.frameCount` to advance rather than sleeping.

## Physics view (`viewer/src/physics/`, metadata `physics`)

Optional per component; the viewer shows a "Physics" folder only when present.
`type: "sheet_conduction"` (chip resistor) — the film is a 2D sheet:

- `solver.ts` — red-black SOR for ∇·(σ∇V)=0 on a cell grid (film / +contact / 0 V contact /
  insulator), coarse-to-fine start, warm restarts while dragging. Returns V, J, |J|²,
  resistance (R = R_sheet · r, with R_sheet calibrated so the modelled trim = `nominal_ohm`)
  and equal-current streamlines (their spacing *is* the current density).
  Validated: untrimmed film = L/W squares within 1 %; current in = current out.
- `shading.ts` — `injectPhysics(material, role)` patches standard materials (surfaces and
  section caps) with shared uniforms; roles FILM (potential red→black, equipotentials,
  heat dark→orange→white, kerf mask), POSITIVE/NEGATIVE (terminal metal), BODY (heat spread).
- `sheet.ts` — controller: field texture (R=V, G=|J|²/q_ref, B=blurred heat, A=conductor),
  film "skin" (top surface incl. the electrode step, so any trim can be shown), particles,
  staged 8 s power-on sequence, V/I/P/R readout. Heat display = |J|²/q_ref × (V/V_ref)², with
  q_ref fixed from the modelled trim, so trims and voltages compare honestly.
- Only the film field is solved. Heat spreading into the body/terminals is illustrative and
  the HUD says so — keep that distinction if you extend it.
- Metadata keys: `film_layer, domain, contact_x, surface{z_low,z_high,x_step}, z_substrate,
  trim{x0,kerf,sy,y_film_edge,y_tip,leg_end_x,leg_end_x_max}, contacts{positive,negative},
  thermal_layers, fade_layers, hide_layers, electrical{nominal_ohm,rated_power_w,
  max_working_voltage_v}, camera`. URL: `?physics=1` (static), `?physics=play`, or `?physics=ac` (capacitor/inductor start in AC; the README demo link).
- Tests: `viewer/tests/physics.spec.ts` (solver accuracy, conservation, R rises with trim,
  over-rating flag, screenshots in `.test-output/screenshots/physics/`).

`type: "plate_capacitor"` (MLCC) — `physics/capacitor.ts`:

- 2D electrostatics ∇·ε∇V=0 in the longitudinal section (CAD x-z, `plane`), extruded across
  `electrode_width`: C = ε₀·εr·flux·width. Plates and the termination-covered surface
  (end faces + |x| ≥ `band_inner_x` on top/bottom) are fixed; other ceramic surfaces are
  zero-flux (εr ≈ 2500 keeps the field inside).
- The grid is aligned to the stack (dz divides the plate pitch and ~the plate thickness;
  plate faces on cell faces). Fixed cells couple at their *face* (half a cell) — without
  both, a 3-cell gap under-reads C by ~25 %. Validated: C/C_parallel-plate = 1.0–1.25
  (fringing), mid-gap V = 0.5, flux in = flux out.
- Overlays in the section plane: field lines (equal flux), surface charge (∝ normal E),
  BaTiO₃ dipoles (align with E during the sequence). Shader `PHYS_PLANE=1` maps (x, z);
  palette 1 = field strength. HUD compares with a real part (`electrical.real_part`) and
  shows the X7R DC-bias drop (illustrative curve, labelled).
- Metadata keys: `plane, dielectric_layer, domain (x,z), plates[{x,z,potential}],
  band_inner_x, electrode_width, overlap{x,gap,gaps}, contacts, line_count, electrical, camera`.
  Optional (ceramic disc): `frame{origin,x,y,z}` — the solver's axes in CAD (overlays and
  `uWorldToCad` go through it, so any section plane works with the x-z solver);
  `plate_shape: "disc"` — C = ε₀εr·πr²/d at the *true* thickness × the section's fringing
  ratio (no extrusion); `end_terminations: false`; `arrow_axis: "z"`; `camera.box`.
  Disc design sliders (d, electrode Ø, εr) **reshape the drawn part and re-solve**: `design`
  (metadata) lists layers to reshape — `dielectric` scales along the disc axis, `plate` scales
  radially and moves with its face, `shift` moves with its face (optional z ramp keeps a lead's
  pin in its hole). `redesign()` rewrites those vertex buffers (stencils share the geometry, so
  caps follow), rebuilds the solver meta, and re-solves; `section.drawLast(ids)` makes the
  reshaped layers' caps win over the coating carved around the old shape. εr and E = V/d set
  charge-glyph size (σ = εE), dipole length (P ∝ (εr−1)E) and the |E| colour.
- AC mode (`state.ac`): quasi-static — the field at any instant is V(t)·(solved field), valid
  because the part is ≪ the wavelength. Potential uses a diverging palette (blue −, black 0,
  red +) via `uAcScale`; the |E| view follows |sin ωt|, the displacement-current view
  ε·∂E/∂t follows |cos ωt| (90° ahead). Charges swap sign, dipoles flip/stretch, arrows show
  the termination current C·dV/dt. Frequency-domain numbers use the *real* part:
  `electrical.ac{esl_h, esr_ohm, filter_source_ohm}` → X_C, |Z| with ESR/ESL, self-resonance,
  phase, filter attenuation. The animation is slowed; the HUD states the real frequency.
`type: "coil_magnetics"` (inductor) — `physics/inductor.ts`:

- 2D magnetostatics ∇·(ν∇A) = −J (ν = 1/μr, A = A_y/μ₀, A = 0 on the outer air boundary) in
  the section through the coil axis, solved for 1 A with the ferrite and with an air core
  (`solvePoisson`, harmonic-mean face ν). Coil sides crossing y = 0 are `cuts` (±1 A each;
  a via landing on a mid-side point counts once). B = μ₀∇×A; field lines = contours of A at
  equal steps (equal flux between lines), oriented along B, with moving flux markers.
  Current markers follow `coil_path` (the helix centre-line) in 3D.
- Validated: ∮H·dl = enclosed current (discrete Ampère, <2 %); B in the window ≫ B above the
  part; ferrite/air B gain between 1.5 and μr. Don't compare stored-energy ratios with μr:
  the air-core solution is squeezed by the finite domain. The 2D L estimate (per-depth
  energy × coil depth) is labelled an approximation next to the datasheet value.
- DC "energize": i = 1 − e^(−t/τ), induced E = −∂A/∂t ∝ −di/dt (red/blue), air-core →
  ferrite blend (`uCore`), then steady state (V = I·R_dc). AC: B ∝ sin, induced E ∝ −cos,
  ⊙/⊗ swap; real-part |Z| = (R_dc + jωL) ∥ C_par; series-choke filter example.
  Saturation is an illustrative L/(1 + (I/I_half)²).
- Palette 2 = magnetic (dark → green → yellow → white).
- Optional (shielded axial inductor): `axisym{axis_z}` — round coil solved as ψ = r·A_φ with
  coefficient ν/r, ψ = 0 on the axis (an odd row count puts the axis on the centre row; the
  `zero` mask of `PoissonProblem`), the winding's J the same sign on both sides, |B| = |∇ψ|/r
  (2ψ(dy)/dy² on the axis), energy over π|r| per half → a true 3D L (= 2W at 1 A), shown as the
  inductance. Solved with `solvePoissonCG` (Jacobi-PCG, float64): SOR took 32 s on the
  μr × 1/r contrast, CG 1 s. `ferrite[{rect, group?}]` replaces `body`; group "shield" follows
  the Shield toggle (`setShield` re-solves; `shield_layer` is hidden). `cuts[].amps` = amp-turns
  per cut (one block for N turns); `core_layers`, `probe{window, above}`, `grid_nx`.
  A closed ferrite path needs its real gap: the sleeve sits 0.15 mm above the flanges (≥ 3
  cells); without it L came out 13× the marked value. Validated: Ampère to 1e-6, shielded L =
  46.9 µH for 31 turns (marked 47), unshielded 7.5 µH, B outside ×5 without the shield.

`type: "helical_film"` (carbon film resistor) — `physics/helix.ts`, sharing `physics/film.ts`
(`FilmPhysics`: texture, skin, particles, sequence, fade; `sheet.ts` is the L-trim subclass):

- The film on the rod is solved unrolled: x along the axis, s = angle·radius around it,
  `periodicY` grid (wraps; angle from +Y towards +Z, shader `PHYS_PLANE=2` via `uCyl`).
  `spiral.ts` rasterises the helical groove (`x = x_start + pitch·u/C`, kerf along the axis).
- Nothing is calibrated: R = (ρ/t)·squares with `electrical.resistivity_ohm_m` (typical) and
  the true film thickness. Sliders: thickness t, turns (track length), track width
  (pitch − kerf); thickness only rescales, the other two re-solve (coarse `dragNx` grid while
  dragging, refined after 250 ms). HUD compares with ρℓ/(w·t), ℓ ≈ (N − 1) turns (the first
  turn of cut only starts the track) and with the uncut tube (L/πD squares).
- Solver precision: potentials and SOR weights are float64 (float32 weights don't sum to 1;
  the bias unbalanced current in/out by ~2 % on a 90-square track); iteration continues until
  current in = out within 0.1 %; ω is chosen for `grid.pathLength` (the track is ~5× the grid).
- Validated: uncut tube = L/πD within 1 %, current conserved, R ∝ 1/t, R rises with turns
  and falls with width, solved R within 10 % of ρℓ/(w·t). Grid nx = 96 (~2 % high vs
  converged; first-order in cell size from the rasterised kerf).
- Metadata keys: `film_layer, axis{x_center,y,z}, radius, domain (x, s), contact_x,
  spiral{x_start,x_limit,pitch,turns,kerf,start_angle}, film{thickness_um,length}, contacts,
  thermal_layers, fade_layers, hide_layers, electrical{…, tolerance, resistivity_ohm_m},
  camera{direction, box}` (`box` frames the body, not the leads).

`type: "electrolytic"` (aluminium electrolytic and tantalum, `electrical.kind`) — `physics/electrolytic.ts`, own GUI/HUD:

- **Computed, not solved** (the HUD says so): the dielectric is anodic Al₂O₃ ~30 nm thick, so
  its field is exactly V/d. d = `nm_per_volt` × forming voltage; C is the marked value and the
  etch gain is the one it implies (C / smooth-foil C, ≈ 38×). Design what-if sliders: forming
  voltage (oxide thickness → oxide |E| colour and warnings), etch gain and foil length → C. Foil
  length trims the drawn winding: shader `PHYS_RCUT` on `foil_layers` paints foil beyond
  r_lim = √(r_in² + f·(r_out² − r_in²)) in the paper colour (`uRadialCut`). A HUD SVG draws the
  etched foil (tunnel count ∝ gain, oxide stroke ∝ forming V). GLSL: `active` is reserved.
- Shading reuses the roles: anode/tab/lead POSITIVE (blue when reversed via `uAcScale`),
  cathode + electrolyte-soaked separator NEGATIVE (the electrolyte is the real cathode), oxide
  FILM on a 1×1 texture with palette 1 (|E| / forming field). `uMetalHeat = 0` keeps the foils'
  polarity colours while the oxide shows field strength.
- Metadata keys: `plane, dielectric_layer, contacts, electrical{kind, capacitance_f,
  rated_voltage_v, forming_voltage_v, nm_per_volt, epsilon_r, ref_length_mm, ref_area_mm2
  (smooth anode area at that length), gain_max, leakage_cv, esr_ohm, foil_width_mm?},
  oxide_um_true, model_turns?, cut_layers, cut_color_layer, cut{mode: radial|axis, center,
  axis?, r_in, r_out}, camera{direction, box}`. The length slider trims radially (winding:
  area ∝ r²) or along `cut.axis` (pellet: ∝ length); `uCutAxis` = (0,0) selects radial.
  Wording per kind lives in `TEXT` (stages, reverse-voltage warning, structure drawing:
  etched foil tunnels vs sintered particles).

`type: "rotary_track"` (trimmer potentiometer) — `physics/arc.ts` (a `FilmPhysics` subclass):

- Sheet conduction solved on a cermet arc in the CAD XZ plane (`mapping "xz"`, shader
  `PHYS_PLANE=1`; heat depth runs along +y behind `film_y`). Pad sectors beyond the ends are
  HIGH (pin 1) / LOW (pin 3); R_sheet is calibrated so end-to-end = `nominal_ohm`.
- The wiper is a tap: unloaded it samples V at its angle; loaded, its cells are `FIXV` (solver
  type with per-cell `grid.fixed`, current reported as `iFix`) at the v where tap current =
  v·V/R_load — linear in v, so two probe solves give v exactly and a third solves the field.
  Validated: v(turns) linear within 3 %, current in = out (+ wiper), 5k/5k with a 10k load → 0.40.
- `solveField()` is the `FilmPhysics` hook for multi-solve cases; streamlines now seed from every
  HIGH→FILM face (curved contacts). Role `TAP` colours wiper / collector / pin 2 by `uTapV`.
- Screw-turn slider: `rotate[{ids, center, plane: xz|xy, deg_per_turn}]` rewrites those layers'
  vertex buffers (and normals) — rotor + wiper about the track axis, the screw about its own.
- Metadata keys: `film_layer, film_y, domain (x,z), center, track{r, from_deg, to_deg, pad_deg},
  wiper{r, half_width}, turns{total, built}, rotate, contacts{positive, negative, wiper},
  thermal_layers, fade_layers, hide_layers, electrical, camera{direction, box}`.

- Viewer framing: `frameBox` raises OrbitControls `maxDistance` and the camera far plane to fit
  large parts (they were fixed for 0603 parts and clipped the 8 mm can when exploded).

- The physics HUD sits at the bottom of the viewport (3 columns); `viewer.setInsetBottom()`
  keeps the part framed above it. HUD updates are throttled to ~10 Hz (DOM + layout each
  frame starves software-GL frames and slows every time-based animation).
