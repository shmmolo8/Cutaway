"""Axial carbon film resistor (DIN 0204 ... driven purely by parameters).

CAD frame (KiCad THT convention): origin = pin 1, X = body axis (pin 2 at +X), Z = up,
z = 0 = PCB surface. The body axis runs at z = D/2, centred at x = pitch/2.

Radial build-up (inside -> out), all solids of revolution about the body axis:
    ceramic rod | carbon film (whole rod surface, spiral groove) | pressed steel caps
    | epoxy lacquer (fills the groove, colour bands painted into it)
Every profile is a rounded rod whose end-corner arcs share one centre, so cap, film and rod
are exact offsets of the outer body. The rod is the derived bulk: its radius is whatever
lacquer, cap and film leave inside the outer diameter.
"""
from __future__ import annotations

import math

from build123d import (Axis, Circle, Edge, Face, Helix, Line, Location, Plane, Rectangle,
                       Solid, Wire, revolve, sweep)

from geometry.core.layers import (Component, LayerSpec, box, carve, clear_plane,
                                  model_thickness_um)

SIDES = (("L", -1.0), ("R", 1.0))


def _revolve(pts_and_arcs: list, xc: float, zc: float) -> Solid:
    """Solid of revolution about the body axis from a closed (ax, r) profile.

    Items are (ax, r) points joined by lines, or ("arc", (ax_centre, r_centre), (ax_end, r_end))
    for a 90-degree arc. Arcs are exact rational quadratic Beziers rather than circles: the
    revolved face is then a surface of revolution, not a torus (OCC over-meshes tori).
    """
    edges, cur = [], None
    for item in pts_and_arcs:
        if item[0] == "arc":
            (cx, cy), end = item[1], item[2]
            corner = (cur[0] + end[0] - cx, cur[1] + end[1] - cy)
            edges.append(Edge.make_bezier(cur, corner, end, weights=[1.0, math.sqrt(0.5), 1.0]))
            cur = end
        else:
            if cur is not None and (abs(item[0] - cur[0]) > 1e-12 or abs(item[1] - cur[1]) > 1e-12):
                edges.append(Line(cur, item))
            cur = item
    first = pts_and_arcs[0]
    if abs(first[0] - cur[0]) > 1e-12 or abs(first[1] - cur[1]) > 1e-12:
        edges.append(Line(cur, first))
    face = Face(Wire(edges))
    solid = revolve(face, Axis.X, 360)
    return solid.solids()[0].moved(Location((xc, 0, zc)))


def rounded_rod(h: float, r: float, f: float, xc: float, zc: float, ax_range=None) -> Solid:
    """Rod of half-length h and radius r with its end corners rounded by radius f.
    `ax_range=(a0, a1)` keeps only that axial slice (a0 < a1, both within [-h, h])."""
    pts = [(-h, 0.0), (-h, r - f), ("arc", (-h + f, r - f), (-h + f, r)),
           (h - f, r), ("arc", (h - f, r - f), (h, r - f)), (h, 0.0)]
    rod = _revolve(pts, xc, zc)
    if ax_range is None:
        return rod
    a0, a1 = ax_range
    return rod.intersect(box(xc + a0, xc + a1, -r - 1, r + 1, zc - r - 1, zc + r + 1)).solids()[0]


def build(params: dict, variant: str) -> Component:
    dim, sp, desc = params["dimensions"], params["spiral"], params["layers"]
    ex = params["exaggeration"]

    t_true_um = {k: float(v) for k, v in params["thickness_um"].items()}
    t_model_um = {k: model_thickness_um(v, variant, ex) for k, v in t_true_um.items()}
    t = {k: v / 1000.0 for k, v in t_model_um.items()}

    L, D = dim["length"], dim["diameter"]
    R, h_out, f_out = D / 2, L / 2, dim["end_round_radius"]
    xc, zc = dim["pitch"] / 2, D / 2
    t_f, t_cap, t_lq, t_sn, t_band = t["carbon_film"], t["cap"], t["lacquer"], t["lead_plating"], t["band"]

    # ---------------------------------------------------------------- radial / axial stations
    # every rounded corner is concentric: centre (ax, r) = (h_out - f_out, R - f_out)
    r_cap, h_cap = R - t_lq, h_out - t_lq          # cap outer surface
    r_film, h_film = r_cap - t_cap, h_cap - t_cap  # film outer surface = cap inner surface
    r_core, h_core = r_film - t_f, h_film - t_f    # ceramic rod
    f = lambda r: r - (R - f_out)                  # corner radius of a profile with radius r

    def rod_radius(tt: dict[str, float]) -> float:
        return R - tt["lacquer"] - tt["cap"] - tt["carbon_film"]

    r_core_true = rod_radius({k: v / 1000 for k, v in t_true_um.items()})
    if 2 * r_core < ex["min_substrate_fraction"] * D:
        raise ValueError(f"{variant}: rod diameter {2 * r_core:.3f} mm < "
                         f"{ex['min_substrate_fraction']:.0%} of D; lower exaggeration.max_um")
    if f(r_core) <= 0:
        raise ValueError("end rounding radius too small for the build-up")

    a_skirt = h_cap - dim["cap_length"]            # inner edge of each cap skirt
    r_mid = r_film + t_lq                          # lacquer surface between the caps
    a_step = a_skirt - t_lq                        # lacquer climbs onto the cap here
    if a_step <= 0:
        raise ValueError("caps too long")

    # ---------------------------------------------------------------- spiral groove
    k, p, n_turns = sp["kerf_width"], sp["pitch"], sp["turns"]
    ax_start = -a_skirt + sp["end_margin"]        # groove centre-line starts here ...
    ax_end = ax_start + n_turns * p               # ... and advances one pitch per turn
    ax_limit = a_skirt - sp["end_margin"]
    if ax_end + k / 2 > ax_limit + 1e-9 or p <= k:
        raise ValueError("spiral does not fit between the caps")
    th0 = math.radians(sp["start_angle_deg"])
    helix = Helix(pitch=p, height=n_turns * p, radius=r_film - t_f / 2)
    # profile in the axial plane: kerf wide along the axis, reaching into rod and lacquer
    depth = t_f + 2 * min(t_f, 0.01)
    profile = Plane(origin=(r_film - t_f / 2, 0, 0), x_dir=(1, 0, 0), z_dir=(0, -1, 0)) * Rectangle(depth, k)
    groove = sweep(profile, path=helix, is_frenet=True).solids()[0]
    # helix frame (Z = axis, angle from X) -> CAD (X = axis, angle from +Y towards +Z)
    frame = Plane(origin=(xc + ax_start, 0, zc), x_dir=(0, 1, 0), z_dir=(1, 0, 0))
    groove = groove.moved(Location(frame) * Location((0, 0, 0), (0, 0, 1), math.degrees(th0)))

    # ---------------------------------------------------------------- layer specs
    no_t = set(params.get("no_thickness", []))      # wire cores: sized by diameter, not a film

    def spec(id_, kind, envelope, sign=1.0, group=None, tkey=None, **kw):
        d = desc[kind]["explode"]["direction"]
        tk = tkey or kind
        return LayerSpec(
            id=id_, kind=kind, envelope=envelope,
            explode_direction=(d[0] * sign, d[1], d[2]),
            explode_order=int(desc[kind]["explode"]["order"]),
            group=group,
            thickness_true_um=None if kind in no_t else t_true_um.get(tk, round(2 * r_core_true * 1000, 3)),
            thickness_model_um=None if kind in no_t else t_model_um.get(tk, round(2 * r_core * 1000, 3)),
            **kw,
        )

    specs = [spec("core", "core", rounded_rod(h_core, r_core, f(r_core), xc, zc), derived=True)]
    specs.append(spec("carbon_film", "carbon_film", rounded_rod(h_film, r_film, f(r_film), xc, zc),
                      cuts=[groove]))
    for s, sg in SIDES:
        rng = (a_skirt, h_cap) if sg > 0 else (-h_cap, -a_skirt)
        specs.append(spec(f"cap_{s}", "cap", rounded_rod(h_cap, r_cap, f(r_cap), xc, zc, rng),
                          sign=sg, group=f"termination_{s}"))

    # leads: straight out of the cap centre, 90-degree bend, straight down through the PCB
    r_lead, rb = dim["lead_diameter"] / 2, dim["lead_bend_radius"]
    z_bottom = -dim["lead_length_below"]
    for s, sg in SIDES:
        x_pin = 0.0 if sg < 0 else dim["pitch"]
        x_cap = xc + sg * h_cap
        x_bend = x_pin - sg * rb                    # bend starts (horizontal part ends) here
        if sg * (x_bend - x_cap) <= 0 or zc - rb <= z_bottom:
            raise ValueError("lead bend does not fit")
        path = Wire([
            Line((x_cap, 0, zc), (x_bend, 0, zc)),
            Edge.make_bezier((x_bend, 0, zc), (x_pin, 0, zc), (x_pin, 0, zc - rb),
                             weights=[1.0, math.sqrt(0.5), 1.0]),
            Line((x_pin, 0, zc - rb), (x_pin, 0, z_bottom)),
        ])
        start = Plane(origin=(x_cap, 0, zc), z_dir=(-sg, 0, 0))
        wire_env = lambda r: sweep(start * Circle(r), path=path).solids()[0]
        specs.append(spec(f"lead_{s}", "lead", wire_env(r_lead - t_sn), sign=sg, group=f"termination_{s}"))
        specs.append(spec(f"lead_plating_{s}", "lead_plating", wire_env(r_lead), sign=sg,
                          group=f"termination_{s}"))

    # colour bands: rings painted into the outer lacquer between the caps
    bw = params["bands"]["width"]
    for b in params["bands"]["items"]:
        a0, a1 = b["center"] - bw / 2, b["center"] + bw / 2
        if a0 < -a_step or a1 > a_step:
            raise ValueError(f"{b['kind']} is not on the straight part of the body")
        ring = _revolve([(a0, r_mid - t_band), (a1, r_mid - t_band), (a1, r_mid), (a0, r_mid)], xc, zc)
        specs.append(spec(b["kind"], b["kind"], ring, tkey="band"))

    # lacquer: conformal coat, r_mid between the caps, climbing over each cap skirt edge
    fo = f_out
    prof = [                                         # -X end on the axis, over the top, +X end
        (-h_out, 0.0), (-h_out, R - fo),
        ("arc", (-(h_out - fo), R - fo), (-(h_out - fo), R)),
        (-a_skirt, R),
        (-a_step, r_cap),                                  # chamfered over the skirt edge
        (-a_step, r_mid), (a_step, r_mid), (a_step, r_cap),
        (a_skirt, R),
        (h_out - fo, R),
        ("arc", (h_out - fo, R - fo), (h_out, R - fo)),
        (h_out, 0.0),
    ]
    specs.append(spec("lacquer", "lacquer", _revolve(prof, xc, zc)))

    layers = carve(specs)

    # ---------------------------------------------------------------- viewer presets (CAD frame)
    ids = [l.id for l in layers]
    band_ids = [b["kind"] for b in params["bands"]["items"]]
    presets = [
        {"id": "exterior", "label": "Exterior", "plane": None, "explode": 0.0,
         "camera": {"direction": [0.55, -1.3, 0.75]}},
        {"id": "longitudinal", "label": "Longitudinal section",
         "plane": {"normal": [0, 1, 0], "point": [xc, 0, zc]}, "explode": 0.0,
         "camera": {"direction": [0.0, -1.0, 0.15], "fit": "section"}},
        {"id": "spiral", "label": "Carbon spiral (lacquer hidden)", "plane": None, "explode": 0.0,
         "hide": ["lacquer", *band_ids],
         "camera": {"direction": [0.25, -1.0, 0.55]}},
        {"id": "transverse_mid", "label": "Transverse section (middle)",
         "plane": {"normal": [-1, 0, 0], "point": [xc + 0.25, 0, zc]}, "explode": 0.0,
         "camera": {"direction": [1.0, -0.35, 0.3], "fit": "section"}},
        {"id": "transverse_cap", "label": "Transverse section (end cap)",
         "plane": {"normal": [-1, 0, 0], "point": [xc + (a_skirt + h_cap) / 2 - 0.1, 0, zc]}, "explode": 0.0,
         "camera": {"direction": [1.0, -0.35, 0.3], "fit": "section"}},
        {"id": "exploded", "label": "Fully exploded", "plane": None, "explode": 1.0,
         "camera": {"direction": [0.5, -1.4, 0.6]}},
    ]
    for preset in presets:
        if preset["plane"]:
            preset["plane"] = clear_plane(layers, preset["plane"])

    levels = {
        "axis_z": zc, "body_center_x": xc, "rod_radius": r_core, "film_radius": r_film,
        "cap_outer_radius": r_cap, "lacquer_mid_radius": r_mid, "cap_skirt_ax": a_skirt,
        "cap_outer_ax": h_cap, "spiral_start_ax": ax_start, "spiral_end_ax": ax_end,
    }

    # ---------------------------------------------------------------- physics (viewer)
    # The film is a sheet on the cylinder: unrolled, x along the axis and s = angle * r_film
    # around it (periodic). Film under a cap is shorted by the cap (contact).
    side = lambda s_: [i for i in ids if i.endswith(f"_{s_}")]
    elec = params["electrical"]
    circ = 2 * math.pi * r_film
    physics = {
        "type": "helical_film",
        "film_layer": "carbon_film",
        "axis": {"x_center": xc, "y": 0.0, "z": zc},
        "radius": r_film,
        "domain": [[xc - a_skirt - 0.08, 0.0], [xc + a_skirt + 0.08, circ]],
        "contact_x": [xc - a_skirt, xc + a_skirt],
        "spiral": {"x_start": xc + ax_start, "x_limit": xc + ax_limit, "pitch": p, "turns": n_turns,
                   "kerf": k, "start_angle": th0},
        "film": {"thickness_um": t_true_um["carbon_film"], "length": 2 * a_skirt},
        "contacts": {"positive": side("L"), "negative": side("R")},
        "thermal_layers": [i for i in ids if i not in ("carbon_film", "lacquer", *band_ids)],
        "fade_layers": ["lacquer"],
        "hide_layers": band_ids,
        "electrical": elec,
        "camera": {"direction": [0.2, -1.0, 0.6],                   # frame the body, not the leads
                   "box": [[xc - h_out, -R, zc - R], [xc + h_out, R, zc + R]]},
    }

    return Component(
        id=f"{params['component']}_{params['size']}", family=params["component"],
        size=str(params["size"]), name=params["display_name"], variant=variant,
        layers=layers, presets=presets, levels={k_: round(v, 6) for k_, v in levels.items()},
        explode_step_mm=params["explode"]["step_mm"], params=params, physics=physics,
    )

