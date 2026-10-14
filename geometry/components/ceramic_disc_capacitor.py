"""Radial ceramic disc capacitor (driven purely by parameters).

CAD frame (KiCad THT convention): origin = pin 1, X = lead to lead, Y = disc axis, Z = up.
Build-up: ceramic disc | silver electrode on each face | lead soldered along each face
(-Y face: pin 1, +Y face: pin 2) | dipped epoxy coat. The ceramic is the derived bulk:
the electrode stack thickness is fixed, the ceramic is what the electrodes leave.
"""
from __future__ import annotations

import math

from build123d import Axis, Circle, Edge, Line, Location, Plane, Solid, Wire, sweep

from geometry.components.carbon_film_resistor import rounded_rod
from geometry.core.layers import Component, LayerSpec, box, carve, clear_plane, model_thickness_um

SIDES = (("L", -1.0), ("R", 1.0))
EPS0 = 8.854e-12


def disc(radius: float, y0: float, y1: float, xc: float, zc: float) -> Solid:
    """Cylinder about the Y axis through (xc, zc), from y0 to y1."""
    return Solid.make_cylinder(radius, y1 - y0, Plane(origin=(xc, y0, zc), z_dir=(0, 1, 0)))


def build(params: dict, variant: str) -> Component:
    dim, desc, ex = params["dimensions"], params["layers"], params["exaggeration"]
    t_true_um = {k: float(v) for k, v in params["thickness_um"].items()}
    t_model_um = {k: model_thickness_um(v, variant, ex) for k, v in t_true_um.items()}
    t_e, t_e_true = t_model_um["electrode"] / 1000, t_true_um["electrode"] / 1000

    D, W = dim["diameter"], dim["thickness"]
    xc, zc = dim["pitch"] / 2, dim["body_bottom"] + D / 2
    stack = dim["height"]
    t_c, t_c_true = stack - 2 * t_e, stack - 2 * t_e_true
    if t_c < ex["min_substrate_fraction"] * stack:
        raise ValueError(f"{variant}: ceramic {t_c:.3f} mm < {ex['min_substrate_fraction']:.0%} of the stack")
    rc, re = dim["disc_diameter"] / 2, dim["electrode_diameter"] / 2
    if not re < rc < D / 2:
        raise ValueError("electrode must be smaller than the disc, the disc than the body")

    no_t = set(params.get("no_thickness", []))

    def spec(id_, kind, envelope, sign=1.0, group=None, **kw):
        d = desc[kind]["explode"]["direction"]
        return LayerSpec(
            id=id_, kind=kind, envelope=envelope,
            explode_direction=(d[0], d[1] * sign, d[2]),
            explode_order=int(desc[kind]["explode"]["order"]), group=group,
            thickness_true_um=None if kind in no_t else t_true_um.get(kind, round(t_c_true * 1000, 3)),
            thickness_model_um=None if kind in no_t else t_model_um.get(kind, round(t_c * 1000, 3)),
            **kw,
        )

    specs = [spec("ceramic", "ceramic", disc(rc, -t_c / 2, t_c / 2, xc, zc), derived=True)]
    for s, sg in SIDES:
        y0, y1 = sorted((sg * t_c / 2, sg * stack / 2))
        specs.append(spec(f"electrode_{s}", "electrode", disc(re, y0, y1, xc, zc), sign=sg, group=f"terminal_{s}"))

    # leads: up from the pin, a step across onto the face line (below the disc), a kink in to
    # the face position (off the ceramic at any height), straight up the electrode face
    r_l = dim["lead_diameter"] / 2
    y_lead = stack / 2 + dim["solder_gap"] + r_l
    z_a, z_y, z_x = dim["lead_kink"]
    if xc - r_l <= rc:      # until it is on the face line the lead stays at the pin, beside the disc
        raise ValueError("pins too close: the lead would cross the disc before reaching its face")
    leads, solders = {}, {}
    for s, sg in SIDES:
        x_pin = xc + sg * xc
        x_in, y_in = xc + sg * dim["lead_inset"], sg * y_lead
        hy, hx = (z_y - z_a) / 2, (z_x - z_y) / 2
        # tightest bend of each S-curve (at its ends) is 1.5 a^2 / offset; under the wire
        # radius the swept surface folds onto itself
        for a_, off in ((hy, y_lead), (hx, abs(x_in - x_pin))):
            if 1.5 * a_ ** 2 / off < 1.2 * r_l:
                raise ValueError(f"lead bend radius {1.5 * a_ ** 2 / off:.2f} mm too tight: spread lead_kink")
        path = Wire([
            Line((x_pin, 0, -dim["lead_below"]), (x_pin, 0, z_a)),
            Edge.make_bezier((x_pin, 0, z_a), (x_pin, 0, z_a + hy), (x_pin, y_in, z_y - hy), (x_pin, y_in, z_y)),
            Edge.make_bezier((x_pin, y_in, z_y), (x_pin, y_in, z_y + hx), (x_in, y_in, z_x - hx), (x_in, y_in, z_x)),
            Line((x_in, y_in, z_x), (x_in, y_in, dim["lead_top"])),
        ])
        start = Plane(origin=(x_pin, 0, -dim["lead_below"]), z_dir=(0, 0, 1))
        leads[s] = sweep(start * Circle(r_l), path=path).solids()[0]
        sz0, sz1 = dim["solder_z"]
        hw = dim["solder_half_width"]
        solders[s] = box(x_in - hw, x_in + hw, sg * stack / 2, y_in, zc + sz0, zc + sz1)
    for s, sg in SIDES:                          # lead before solder: the solder fills around it
        specs.append(spec(f"lead_{s}", "lead", leads[s], sign=sg, group=f"terminal_{s}"))
    for s, sg in SIDES:
        specs.append(spec(f"solder_{s}", "solder", solders[s], sign=sg, group=f"terminal_{s}"))

    # dipped coat: rounded "pillow" about the disc axis
    f = dim["coat_round_radius"]
    coat = rounded_rod(W / 2, D / 2, f, 0, 0).rotate(Axis.Z, 90).moved(Location((xc, 0, zc)))
    specs.append(spec("coating", "coating", coat))

    layers = carve(specs)

    # ---------------------------------------------------------------- presets (CAD frame)
    x_lead_l = xc - dim["lead_inset"]
    presets = [
        {"id": "exterior", "label": "Exterior", "plane": None, "explode": 0.0,
         "camera": {"direction": [0.6, -1.3, 0.6]}},
        {"id": "longitudinal", "label": "Vertical section through a lead",
         "plane": {"normal": [1, 0, 0], "point": [x_lead_l, 0, zc]}, "explode": 0.0,
         "camera": {"direction": [-1.0, -0.25, 0.2], "fit": "section"}},
        {"id": "horizontal", "label": "Horizontal section (plates and dielectric)",
         "plane": {"normal": [0, 0, -1], "point": [xc, 0, zc]}, "explode": 0.0,
         "camera": {"direction": [0.0, -0.35, 1.0], "fit": "section"}},
        {"id": "inside", "label": "Inside (coating hidden)", "plane": None, "explode": 0.0,
         "hide": ["coating"], "camera": {"direction": [0.6, -1.3, 0.6]}},
        {"id": "exploded", "label": "Fully exploded", "plane": None, "explode": 1.0,
         "camera": {"direction": [1.0, -1.3, 0.6]}},
    ]
    for preset in presets:
        if preset["plane"]:
            preset["plane"] = clear_plane(layers, preset["plane"])

    levels = {"disc_center_x": xc, "disc_center_z": zc, "ceramic_thickness": t_c,
              "electrode_radius": re, "disc_radius": rc, "lead_face_y": y_lead}

    # ---------------------------------------------------------------- physics (viewer)
    # Same field solve as the MLCC, in its own frame: solver x = CAD x - xc, solver z = CAD y
    # (across the plates), solver y = -(CAD z - zc): the section is the horizontal mid-plane.
    elec = params["electrical"]
    ids = [l.id for l in layers]
    plane = next(p["plane"] for p in presets if p["id"] == "horizontal")
    zp = plane["point"][2]
    physics = {
        "type": "plate_capacitor",
        "plate_shape": "disc",
        "end_terminations": False,
        "frame": {"origin": [xc, 0, zp], "x": [1, 0, 0], "y": [0, 0, -1], "z": [0, 1, 0]},
        "plane": plane,
        "dielectric_layer": "ceramic",
        "domain": [[-rc, -stack / 2], [rc, stack / 2]],
        "plates": [{"x": [-re, re], "z": [-stack / 2, -t_c / 2], "potential": 1},
                   {"x": [-re, re], "z": [t_c / 2, stack / 2], "potential": 0}],
        "band_inner_x": 1e9,
        "electrode_width": 2 * re,
        "overlap": {"x": [-re, re], "gap": t_c, "gaps": 1},
        "arrow_axis": "z",                         # AC current arrows: into/out of the faces
        # design sliders reshape the part in the viewer: ceramic thickness, plate diameter;
        # leads and solder move with their face (the lead only above its step onto the face line)
        "design": {"center": [xc, 0, zc], "layers": {
            "ceramic": ["dielectric", 0], "electrode_L": ["plate", -1], "electrode_R": ["plate", 1],
            "solder_L": ["shift", -1], "solder_R": ["shift", 1],
            "lead_L": ["shift", -1, z_a, z_y], "lead_R": ["shift", 1, z_a, z_y]}},
        "contacts": {"positive": [i for i in ids if i.endswith("_L")],
                     "negative": [i for i in ids if i.endswith("_R")]},
        "line_count": 8,
        "electrical": {
            "epsilon_r": elec["epsilon_r"], "rated_voltage_v": elec["rated_voltage_v"],
            "real_part": {"capacitance_f": elec["capacitance_f"], "dielectric_um": round(t_c_true * 1000, 3)},
            "dc_bias_e_half_v_per_um": elec["dc_bias_e_half_v_per_um"], "ac": elec["ac"],
            "electrode_diameter_mm": 2 * re,
        },
        "camera": {"direction": [0.0, -0.35, 1.0],                  # frame the solved section
                   "box": [[xc - rc, -2 * stack, zp - 0.1], [xc + rc, 2 * stack, zp]]},
    }

    return Component(
        id=f"{params['component']}_{params['size']}", family=params["component"],
        size=str(params["size"]), name=params["display_name"], variant=variant,
        layers=layers, presets=presets, levels={k: round(v, 6) for k, v in levels.items()},
        explode_step_mm=params["explode"]["step_mm"], params=params, physics=physics,
    )
