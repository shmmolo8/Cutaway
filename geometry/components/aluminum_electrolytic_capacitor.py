"""Radial aluminium electrolytic capacitor (driven purely by parameters).

CAD frame (KiCad THT convention): origin = pin 1 (+), z = 0 = PCB, can axis vertical at
x = pitch/2, y = 0. Build-up: wound element (anode foil + oxide skin, cathode foil, paper
separator soaked in electrolyte = the derived bulk), foil tabs welded to the leads, rubber
seal, aluminium can with rolled groove and vent score, sleeve with polarity stripe.

The winding is a two-centre spiral of semicircles (centres alternate at -p/4 and +p/4,
radius grows p/2 per half turn): every offset of it is an exact concentric arc, so a
nanometre oxide on a 100 um foil stays exact. The cathode is the same spiral turned 180
degrees, which puts it half a pitch outside the anode all the way round.
"""
from __future__ import annotations

import math

from build123d import Axis, Face, Location, Plane, Solid, Wire, extrude

from geometry.components.carbon_film_resistor import _revolve
from geometry.core.layers import Component, LayerSpec, box, carve, clear_plane, model_thickness_um, union

SIDES = (("L", -1.0), ("R", 1.0))


def revolve_z(profile: list, xc: float) -> Solid:
    """Solid of revolution about the vertical axis at (xc, 0) from a closed (z, r) profile."""
    return _revolve(profile, 0, 0).rotate(Axis.Y, -90).moved(Location((xc, 0, 0)))


def spiral_strip(r0: float, p: float, half_turns: int, t: float, z0: float, z1: float, xc: float) -> Solid:
    """Strip of thickness t centred on the two-centre spiral (see module doc)."""
    big = 2 * (r0 + half_turns * p / 2 + p + t)
    pieces = []
    for k in range(half_turns):
        c = -p / 4 if k % 2 == 0 else p / 4
        r = r0 + k * p / 2
        ring = Solid.make_cylinder(r + t / 2, z1 - z0, Plane(origin=(xc + c, 0, z0)))
        ring = ring.cut(Solid.make_cylinder(r - t / 2, z1 - z0, Plane(origin=(xc + c, 0, z0))))
        half = box(xc - big, xc + big, 0, big if k % 2 == 0 else -big, z0 - 1, z1 + 1)
        pieces.append(ring.intersect(half).solids()[0])
    return union(*pieces).solids()[0]


def build(params: dict, variant: str) -> Component:
    dim, wd, desc, ex = params["dimensions"], params["winding"], params["layers"], params["exaggeration"]
    t_true_um = {k: float(v) for k, v in params["thickness_um"].items()}
    t_model_um = {k: model_thickness_um(v, variant, ex) for k, v in t_true_um.items()}
    t = {k: v / 1000 for k, v in t_model_um.items()}
    tt = {k: v / 1000 for k, v in t_true_um.items()}
    no_t = set(params.get("no_thickness", []))

    R, xc = dim["diameter"] / 2, dim["pitch"] / 2
    p, half_turns = wd["pitch"], 2 * wd["turns"]
    if abs(dim["height"] - p / 2) > 1e-3:
        raise ValueError("dimensions.height must be half the winding pitch")
    sep = lambda q: p / 2 - q["anode_foil"] / 2 - q["oxide"] - q["cathode_foil"] / 2   # per gap
    if sep(t) < ex["min_substrate_fraction"] * p / 2:
        raise ValueError(f"{variant}: separator {sep(t):.3f} mm too thin")

    def spec(id_, kind, envelope, sign=1.0, group=None, tkey=None, **kw):
        d = desc[kind]["explode"]["direction"]
        tk = tkey or kind
        return LayerSpec(
            id=id_, kind=kind, envelope=envelope,
            explode_direction=(d[0] * sign, d[1], d[2]),
            explode_order=int(desc[kind]["explode"]["order"]), group=group,
            thickness_true_um=None if kind in no_t else t_true_um.get(tk, round(sep(tt) * 1000, 3)),
            thickness_model_um=None if kind in no_t else t_model_um.get(tk, round(sep(t) * 1000, 3)),
            **kw,
        )

    # ---------------------------------------------------------------- winding
    # the anode passes over pin 1 (x = 0, i.e. -x of the axis) at turn `tab_turn`
    r0 = xc - p / 4 - wd["tab_turn"] * p
    zr0, zr1 = dim["roll_z"]
    zf0, zf1 = zr0 + dim["foil_margin"], zr1 - dim["foil_margin"]
    r_out = r0 + (half_turns - 1) * p / 2 + p / 4 + max(t["anode_foil"] / 2 + t["oxide"], t["cathode_foil"] / 2)
    if r_out >= dim["roll_radius"]:
        raise ValueError("winding does not fit in the roll")
    anode = spiral_strip(r0, p, half_turns, t["anode_foil"], zf0, zf1, xc)
    oxide = spiral_strip(r0, p, half_turns, t["anode_foil"] + 2 * t["oxide"], zf0, zf1, xc)
    cathode = spiral_strip(r0, p, half_turns, t["cathode_foil"], zf0, zf1, xc).rotate(
        Axis((xc, 0, 0), (0, 0, 1)), 180)
    r_hole = r0 - p / 4 - 0.12
    roll = Solid.make_cylinder(dim["roll_radius"], zr1 - zr0, Plane(origin=(xc, 0, zr0)))
    roll = roll.cut(Solid.make_cylinder(r_hole, zr1 - zr0, Plane(origin=(xc, 0, zr0))))

    specs = [spec("anode_foil", "anode_foil", anode),
             spec("oxide", "oxide", oxide, allow_multiple_solids=True),       # skin on both faces
             spec("cathode_foil", "cathode_foil", cathode)]
    tw, tth = dim["tab_width"], dim["tab_thickness"]
    for s, sg in SIDES:                       # tab_L on the anode (pin 1), tab_R on the cathode
        x = xc + sg * xc
        specs.append(spec(f"tab_{s}", "tab", box(x - tth / 2, x + tth / 2, -tw / 2, tw / 2, dim["lead_top"], zf0),
                          group=f"terminal_{s}"))
    specs.append(spec("separator", "separator", roll, derived=True))

    # ---------------------------------------------------------------- leads, can, seal, sleeve
    r_l = dim["lead_diameter"] / 2
    for s, sg in SIDES:
        x = xc + sg * xc
        specs.append(spec(f"lead_{s}", "lead", Solid.make_cylinder(
            r_l, dim["lead_top"] + dim["lead_below"], Plane(origin=(x, 0, -dim["lead_below"]))),
            group=f"terminal_{s}"))

    w, ts = t["can"], t["sleeve"]
    r_can, z_top = R - ts, dim["body_top"] - ts
    zb, b = dim["can_bottom"], dim["bead"]
    bz0, bz1, bd = b["z"] - b["half_width"], b["z"] + b["half_width"], b["depth"]
    can = revolve_z([
        (zb, r_can), (bz0, r_can), (b["z"], r_can - bd), (bz1, r_can), (z_top, r_can), (z_top, 0.0),
        (z_top - dim["can_top_thickness"], 0.0), (z_top - dim["can_top_thickness"], r_can - w),
        (bz1, r_can - w), (b["z"], r_can - w - bd), (bz0, r_can - w), (zb + w, r_can - w),
    ], xc)
    v = dim["vent"]
    vents = [box(xc - v["length"] / 2, xc + v["length"] / 2, -v["width"] / 2, v["width"] / 2,
                 z_top - v["depth"], z_top + 0.1)]
    vents.append(vents[0].rotate(Axis((xc, 0, 0), (0, 0, 1)), 90))
    if zr1 >= z_top - dim["can_top_thickness"] or dim["seal_top"] >= zr0:
        raise ValueError("roll does not fit between the seal and the can top")
    specs.append(spec("can", "can", can, cuts=vents))
    specs.append(spec("seal", "seal", Solid.make_cylinder(r_can - w, dim["seal_top"] - zb, Plane(origin=(xc, 0, zb)))))

    lip, zs = dim["sleeve_lip"], dim["sleeve_bottom"]
    sleeve = revolve_z([(zs, R - lip), (zs, R), (dim["body_top"], R), (dim["body_top"], R - lip),
                        (z_top, R - lip), (z_top, r_can), (zs + ts, r_can), (zs + ts, R - lip)], xc)
    a = math.radians(dim["stripe_half_angle_deg"])
    wedge = extrude(Face(Wire.make_polygon([(xc, 0, -1), (xc + 9 * math.cos(a), 9 * math.sin(a), -1),
                                            (xc + 9 * math.cos(a), -9 * math.sin(a), -1)], close=True)), 12, dir=(0, 0, 1))
    specs.append(spec("stripe", "stripe", sleeve.intersect(wedge).solids()[0], tkey="sleeve"))
    specs.append(spec("sleeve", "sleeve", sleeve))

    layers = carve(specs)

    # ---------------------------------------------------------------- presets (CAD frame)
    zm = (zf0 + zf1) / 2
    presets = [
        {"id": "exterior", "label": "Exterior", "plane": None, "explode": 0.0,
         "camera": {"direction": [0.7, -1.2, 0.8]}},
        {"id": "longitudinal", "label": "Vertical section through both leads",
         "plane": {"normal": [0, 1, 0], "point": [xc, 0, zm]}, "explode": 0.0,
         "camera": {"direction": [0.0, -1.0, 0.15], "fit": "section"}},
        {"id": "horizontal", "label": "Horizontal section (the winding)",
         "plane": {"normal": [0, 0, -1], "point": [xc, 0, zm]}, "explode": 0.0,
         "camera": {"direction": [0.0, -0.25, 1.0], "fit": "section"}},
        {"id": "inside", "label": "Inside (can, sleeve and seal hidden)", "plane": None, "explode": 0.0,
         "hide": ["can", "sleeve", "stripe", "seal"], "camera": {"direction": [0.7, -1.2, 0.8]}},
        {"id": "exploded", "label": "Fully exploded", "plane": None, "explode": 1.0,
         "camera": {"direction": [0.9, -1.3, 0.5]}},
    ]
    for preset in presets:
        if preset["plane"]:
            preset["plane"] = clear_plane(layers, preset["plane"])

    levels = {"axis_x": xc, "winding_r0": r0, "foil_z0": zf0, "foil_z1": zf1, "separator_gap": sep(t),
              "can_radius": r_can, "can_top": z_top}

    # ---------------------------------------------------------------- physics (viewer)
    # Computed, not solved: the field lives in an oxide ~30 nm thick, far thinner than any
    # other dimension, so it is the parallel-plate field V/d everywhere (no fringing to solve).
    ids = [l.id for l in layers]
    physics = {
        "type": "electrolytic",
        "plane": next(q["plane"] for q in presets if q["id"] == "horizontal"),
        "dielectric_layer": "oxide",
        "contacts": {"positive": ["anode_foil", "tab_L", "lead_L"],
                     "negative": ["cathode_foil", "separator", "tab_R", "lead_R"]},
        "electrical": {**params["electrical"], "kind": "aluminum", "gain_max": 150,
                       "ref_length_mm": params["electrical"]["anode_length_mm"],
                       "ref_area_mm2": 2 * params["electrical"]["anode_length_mm"] * params["electrical"]["foil_width_mm"]},
        "oxide_um_true": t_true_um["oxide"],
        # the foil-length slider trims the winding from outside in (length ∝ r_out² - r_in²)
        "cut_layers": ["anode_foil", "oxide", "cathode_foil"],
        "cut_color_layer": "separator",
        "cut": {"mode": "radial", "center": [xc, 0.0], "r_in": r0 - p / 4, "r_out": r_out + p / 4},
        "model_turns": wd["turns"],
        "camera": {"direction": [0.0, -0.25, 1.0],
                   "box": [[xc - R, -R, zm - 0.5], [xc + R, R, zm]]},
    }
    assert set(physics["contacts"]["positive"] + physics["contacts"]["negative"]) <= set(ids)

    return Component(
        id=f"{params['component']}_{params['size']}", family=params["component"],
        size=str(params["size"]), name=params["display_name"], variant=variant,
        layers=layers, presets=presets, levels={k: round(v, 6) for k, v in levels.items()},
        explode_step_mm=params["explode"]["step_mm"], params=params, physics=physics,
    )
