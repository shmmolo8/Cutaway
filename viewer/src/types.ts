/** Metadata schema v1 — see CLAUDE.md. All vectors are in the CAD frame (Z-up, mm). */
export type Vec3 = [number, number, number];

export interface LayerMeta {
  id: string;
  kind: string;
  name: string;
  material: string;
  function: string;
  /** null for parts that are not a layer of some thickness (e.g. lead wires) */
  thickness_true_um: number | null;
  thickness_model_um: number | null;
  /** bulk layer whose thickness is derived from the others */
  derived: boolean;
  color: string;
  roughness: number;
  metalness: number;
  opacity: number;
  group: string | null;
  volume_mm3: number;
  explode: { direction: Vec3; order: number };
}

export interface PlaneMeta {
  normal: Vec3;
  point: Vec3;
}

export interface PresetMeta {
  id: string;
  label: string;
  plane: PlaneMeta | null;
  explode: number;
  /** layer ids to hide for this view (e.g. the body around a coil) */
  hide?: string[];
  camera: { direction: Vec3; fit?: "section" };
}

/** Thin-film sheet conduction (chip resistor). CAD frame, mm. */
export interface SheetPhysicsMeta {
  type: "sheet_conduction";
  film_layer: string;
  domain: [[number, number], [number, number]];
  contact_x: [number, number];
  surface: { z_low: number; z_high: number; x_step: number };
  z_substrate: [number, number];
  trim: { x0: number; kerf: number; sy: number; y_film_edge: number; y_tip: number;
    leg_end_x: number; leg_end_x_max: number };
  contacts: { positive: string[]; negative: string[] };
  thermal_layers: string[];
  fade_layers: string[];
  hide_layers: string[];
  electrical: { nominal_ohm: number; rated_power_w: number; max_working_voltage_v: number };
  camera: { direction: Vec3 };
}

/** Film on a cylinder with a helical cut (carbon film resistor). CAD frame, mm; the film is
 *  unrolled: domain is (x, s) with s = angle * radius, angle from +Y towards +Z, periodic. */
export interface HelixPhysicsMeta {
  type: "helical_film";
  film_layer: string;
  axis: { x_center: number; y: number; z: number };
  radius: number;
  domain: [[number, number], [number, number]];
  contact_x: [number, number];
  spiral: { x_start: number; x_limit: number; pitch: number; turns: number; kerf: number; start_angle: number };
  film: { thickness_um: number; length: number };
  contacts: { positive: string[]; negative: string[] };
  thermal_layers: string[];
  fade_layers: string[];
  hide_layers: string[];
  electrical: { nominal_ohm: number; tolerance: number; rated_power_w: number; max_working_voltage_v: number;
    resistivity_ohm_m: number };
  camera: { direction: Vec3; box?: [Vec3, Vec3] };
}

/** 2D electrostatics in a section plane (MLCC). CAD frame, mm; domain is (x, z). */
export interface PlatePhysicsMeta {
  type: "plate_capacitor";
  plane: PlaneMeta;
  dielectric_layer: string;
  domain: [[number, number], [number, number]];
  plates: { x: [number, number]; z: [number, number]; potential: 0 | 1 }[];
  band_inner_x: number;
  electrode_width: number;
  overlap: { x: [number, number]; gap: number; gaps: number };
  contacts: { positive: string[]; negative: string[] };
  line_count: number;
  electrical: {
    epsilon_r: number; rated_voltage_v: number;
    real_part: { capacitance_f: number; dielectric_um: number };
    dc_bias_e_half_v_per_um: number;
    ac: { esl_h: number; esr_ohm: number; filter_source_ohm: number };
    electrode_diameter_mm?: number;
  };
  camera: { direction: Vec3; box?: [Vec3, Vec3] };
  /** solver frame in CAD (default: identity, section = CAD x-z at y = 0) */
  frame?: { origin: Vec3; x: Vec3; y: Vec3; z: Vec3 };
  /** "disc": circular plates of diameter overlap.x; C = eps0 eps_r pi r^2 / d x 2D fringing */
  plate_shape?: "rect" | "disc";
  /** the domain's end faces are terminations (MLCC, default); false for a disc */
  end_terminations?: boolean;
  /** axis of the AC conduction-current arrows (default x: outside the end faces) */
  arrow_axis?: "x" | "z";
  /** disc design sliders reshape these layers (CAD frame; disc axis = CAD y through `center`):
   *  dielectric scales in y, plates scale radially and move with the faces, shift layers move */
  design?: { center: Vec3; layers: Record<string, ["dielectric" | "plate" | "shift", number, number?, number?]> };
}

/** Trimmer potentiometer: sheet conduction on an arc in the CAD XZ plane (solver (x, y) = CAD (x, z)). */
export interface RotaryTrackMeta {
  type: "rotary_track";
  film_layer: string;
  film_y: number;                 // CAD y of the track's front face
  domain: [[number, number], [number, number]];
  contact_x: [number, number];    // unused (FilmMeta)
  center: [number, number];       // track axis (CAD x, z)
  track: { r: [number, number]; from_deg: number; to_deg: number; pad_deg: number };
  wiper: { r: number; half_width: number };
  turns: { total: number; built: number };
  rotate: { ids: string[]; center: Vec3; plane: "xz" | "xy"; deg_per_turn: number }[];
  contacts: { positive: string[]; negative: string[]; wiper: string[] };
  thermal_layers: string[];
  fade_layers: string[];
  hide_layers: string[];
  electrical: { nominal_ohm: number; rated_power_w: number; max_working_voltage_v: number };
  camera: { direction: Vec3; box?: [Vec3, Vec3] };
}

/** Aluminium electrolytic: computed parallel-plate physics (oxide ~nm thick). CAD frame, mm. */
export interface ElectrolyticPhysicsMeta {
  type: "electrolytic";
  plane: PlaneMeta;
  dielectric_layer: string;
  contacts: { positive: string[]; negative: string[] };
  electrical: {
    capacitance_f: number; rated_voltage_v: number; forming_voltage_v: number; nm_per_volt: number;
    epsilon_r: number; leakage_cv: number; esr_ohm: number;
    kind: "aluminum" | "tantalum";
    ref_length_mm: number;        // the length slider's real value (foil length / pellet length)
    ref_area_mm2: number;         // smooth anode area at that length (foil 2 faces / pellet outside)
    gain_max: number;             // surface-gain slider range
    foil_width_mm?: number;       // aluminium: foil width (text)
  };
  oxide_um_true: number;
  model_turns?: number;
  /** trimmed by the length slider: radial (winding, from outside in) or along an axis (pellet) */
  cut_layers: string[];
  cut_color_layer: string;        // its colour is shown where the anode is trimmed away
  cut: { mode: "radial" | "axis"; center: [number, number]; axis?: [number, number]; r_in: number; r_out: number };
  camera: { direction: Vec3; box?: [Vec3, Vec3] };
}

/** 2D magnetostatics in the section through the coil axis (inductor). CAD frame, mm; (x, z). */
export interface CoilPhysicsMeta {
  type: "coil_magnetics";
  plane: PlaneMeta;
  core_layer: string;
  coil_layer: string;
  domain: [[number, number], [number, number]];
  body: [[number, number], [number, number]];
  cuts: { x: [number, number]; z: [number, number]; dir: number; amps?: number }[];
  coil_path: Vec3[];
  coil_depth: number;
  turns: number;
  /** optional: several ferrite rectangles (section x, z); group "shield" follows the shield toggle */
  ferrite?: { rect: [[number, number], [number, number]]; group?: "shield" }[];
  core_layers?: string[];         // all ferrite layers (field colour, "show ferrite" toggle)
  shield_layer?: string;          // hidden when the shield is switched off
  axisym?: { axis_z: number };    // round coil: solve psi = r·A_phi about this axis (section z)
  grid_nx?: number;               // cells along x (default 240)
  probe?: { window: [number, number]; above: [number, number] };
  contacts: { positive: string[]; negative: string[] };
  electrical: {
    mu_r: number; inductance_h: number; dcr_ohm: number; rated_current_a: number; sat_i_half_a: number;
    parasitic_c_f: number; filter_load_ohm: number; air_margin_mm: number;
  };
  camera: { direction: Vec3 };
}

export interface ComponentMeta {
  schema_version: number;
  component: {
    id: string;
    family: string;
    size: string;
    name: string;
    category: string;
    description: string;
    variant: string;
    variants: Record<string, string>;
    units: "mm";
    up: "+Z";
    bbox: [Vec3, Vec3];
    source: string;
    levels: Record<string, number>;
  };
  explode: { step_mm: number };
  layers: LayerMeta[];
  presets: PresetMeta[];
  physics?: SheetPhysicsMeta | HelixPhysicsMeta | PlatePhysicsMeta | CoilPhysicsMeta | ElectrolyticPhysicsMeta | RotaryTrackMeta;
}

export interface IndexEntry {
  id: string;
  name: string;
  family: string;
  category: string;
  description: string;
  size: string;
  variants: Record<string, string>;
  default_variant: string;
}
