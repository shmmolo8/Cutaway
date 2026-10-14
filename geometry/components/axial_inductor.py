"""Shielded axial inductor (moulded), driven purely by parameters.

CAD frame (KiCad THT convention): origin = pin 1, X = body axis, Z = up, body centred at
x = pitch/2 with its axis at z = axis_z. Placement order: winding | lead-out wires (through
notches in the flanges) | ferrite drum (derived bulk) | end caps | leads | ferrite sleeve
(shield) | colour bands | epoxy coat. All round parts are solids of revolution about X.
"""
from __future__ import annotations

import math

from build123d import Circle, Edge, Line, Plane, Solid, Wire, sweep

from geometry.components.carbon_film_resistor import rounded_rod
from geometry.core.layers import Component, LayerSpec, box, carve, clear_plane, model_thickness_um

SIDES = (("L", -1.0), ("R", 1.0))


def x_tube(r_in: float, r_out: float, a0: float, a1: float, xc: float, zc: float) -> Solid:
    """Tube (or rod if r_in = 0) about the X axis through (xc, zc), axial a0..a1 from xc."""
    rod = Solid.make_cylinder(r_out, a1 - a0, Plane(origin=(xc + a0, 0, zc), z_dir=(1, 0, 0)))
    if r_in > 0:
        rod = rod.cut(Solid.make_cylinder(r_in, a1 - a0, Plane(origin=(xc + a0, 0, zc), z_dir=(1, 0, 0))))
    return rod


def build(params: dict, variant: str) -> Component:
    dim, desc = params["dimensions"], params["layers"]
    model_thickness_um(0, variant, params["exaggeration"])          # validates the variant name
    no_t = set(params.get("no_thickness", []))
    H = dim["height"]

    def spec(id_, kind, envelope, sign=1.0, group=None, **kw):
        d = desc[kind]["explode"]["direction"]
        return LayerSpec(
            id=id_, kind=kind, envelope=envelope,
            explode_direction=(d[0] * sign, d[1], d[2]),
            explode_order=int(desc[kind]["explode"]["order"]), group=group,
            thickness_true_um=None if kind in no_t else H * 1000,
            thickness_model_um=None if kind in no_t else H * 1000, **kw)

    xc, zc = dim["pitch"] / 2, dim["axis_z"]
    dr, wd, sl = dim["drum"], dim["winding"], dim["sleeve"]
    hd, fl, rf = dr["half_length"], dr["flange"], dr["flange_r"]
    rp = H / 2                                                   # post radius
    a_in = hd - fl                                               # inner face of each flange
    aw = a_in - wd["gap"]                                        # winding half-length
    rs = rf + sl["gap"]                                          # sleeve bore: a gap above the flanges
    if not (rp <= wd["r"][0] < wd["r"][1] <= rf < rs < sl["r_out"] < dim["coat"]["r"]):
        raise ValueError("radial build-up out of order")

    specs = [spec("winding", "winding", x_tube(wd["r"][0], wd["r"][1], -aw, aw, xc, zc))]
    lo = dim["leadout"]
    for s, sg in SIDES:                                          # through the flange notch to the cap
        a0, a1 = sorted((sg * aw, sg * hd))
        specs.append(spec(f"leadout_{s}", "leadout",
                          box(xc + a0, xc + a1, -lo["half_width"], lo["half_width"], zc + lo["r"][0], zc + lo["r"][1]),
                          sign=sg, group=f"terminal_{s}"))
    drum = x_tube(0, rp, -a_in, a_in, xc, zc)
    for sg in (-1, 1):
        a0, a1 = sorted((sg * a_in, sg * hd))
        drum = drum.fuse(x_tube(0, rf, a0, a1, xc, zc))
    specs.append(spec("drum", "drum", drum.clean(), derived=True))
    tc = dim["cap"]["thickness"]
    for s, sg in SIDES:
        a0, a1 = sorted((sg * hd, sg * (hd + tc)))
        specs.append(spec(f"cap_{s}", "cap", x_tube(0, rf, a0, a1, xc, zc), sign=sg, group=f"terminal_{s}"))

    # leads: straight out of the cap centre, 90-degree bend (exact rational Bezier), down
    ld = dim["lead"]
    r_l, rb, z_bot = ld["diameter"] / 2, ld["bend_radius"], -ld["below"]
    c = math.sqrt(0.5)
    for s, sg in SIDES:
        x_pin = xc + sg * xc
        x_cap = xc + sg * (hd + tc)
        x_bend = x_pin - sg * rb
        path = Wire([Line((x_cap, 0, zc), (x_bend, 0, zc)),
                     Edge.make_bezier((x_bend, 0, zc), (x_pin, 0, zc), (x_pin, 0, zc - rb), weights=[1.0, c, 1.0]),
                     Line((x_pin, 0, zc - rb), (x_pin, 0, z_bot))])
        lead = sweep(Plane(origin=(x_cap, 0, zc), z_dir=(sg, 0, 0)) * Circle(r_l), path=path).solids()[0]
        specs.append(spec(f"lead_{s}", "lead", lead, sign=sg, group=f"terminal_{s}"))

    specs.append(spec("sleeve", "sleeve", x_tube(rs, sl["r_out"], -hd, hd, xc, zc)))
    co, bd = dim["coat"], dim["bands"]
    for i, ax in enumerate(bd["ax"], start=1):
        specs.append(spec(f"band_{i}", f"band_{i}", x_tube(co["r"], bd["r_out"], ax - bd["width"] / 2, ax + bd["width"] / 2, xc, zc)))
    specs.append(spec("coat", "coat", rounded_rod(co["half_length"], co["r"], co["end_round"], xc, zc)))

    layers = carve(specs)

    # ---------------------------------------------------------------- presets (CAD frame)
    presets = [
        {"id": "exterior", "label": "Exterior", "plane": None, "explode": 0.0,
         "camera": {"direction": [0.5, -1.3, 0.6]}},
        {"id": "longitudinal", "label": "Longitudinal section (drum, winding, sleeve)",
         "plane": {"normal": [0, 1, 0], "point": [xc, 0, zc]}, "explode": 0.0,
         "camera": {"direction": [0.0, -1.0, 0.12], "fit": "section"}},
        {"id": "transverse", "label": "Transverse section (the shield around the winding)",
         "plane": {"normal": [-1, 0, 0], "point": [xc + 0.3, 0, zc]}, "explode": 0.0,
         "camera": {"direction": [1.0, -0.3, 0.25], "fit": "section"}},
        {"id": "inside", "label": "Inside (coat and sleeve hidden)", "plane": None, "explode": 0.0,
         "hide": ["coat", "sleeve", "band_1", "band_2", "band_3", "band_4"], "camera": {"direction": [0.5, -1.3, 0.6]}},
        {"id": "exploded", "label": "Fully exploded", "plane": None, "explode": 1.0,
         "camera": {"direction": [0.5, -1.4, 0.5]}},
    ]
    for p in presets:
        if p["plane"]:
            p["plane"] = clear_plane(layers, p["plane"])

    levels = {"axis_x": xc, "axis_z": zc, "winding_half_length": aw}

    # ---------------------------------------------------------------- physics (viewer)
    # Axisymmetric magnetostatics in the section y = 0: the winding is one block of N
    # amp-turns per side (top: current out of the page, bottom: into it).
    e = params["electrical"]
    m = e["air_margin_mm"]
    rects = [((xc - a_in, zc - rp), (xc + a_in, zc + rp))]
    for sg in (-1, 1):
        a0, a1 = sorted((sg * a_in, sg * hd))
        rects.append(((xc + a0, zc - rf), (xc + a1, zc + rf)))
    ferrite = [{"rect": [list(a), list(b)]} for a, b in rects]
    ferrite += [{"rect": [[xc - hd, zc + rs], [xc + hd, zc + sl["r_out"]]], "group": "shield"},
                {"rect": [[xc - hd, zc - sl["r_out"]], [xc + hd, zc - rs]], "group": "shield"}]
    n_vis = 18                                                       # current markers: a visual helix
    rw = (wd["r"][0] + wd["r"][1]) / 2
    path = [[xc - hd - tc - 1.0, 0, zc], [xc - aw, 0, zc + rw]]
    steps = n_vis * 16
    for k in range(steps + 1):
        a = 2 * math.pi * n_vis * k / steps
        path.append([xc - aw + 2 * aw * k / steps, rw * math.sin(a), zc + rw * math.cos(a)])
    path += [[xc + aw, 0, zc + rw], [xc + hd + tc + 1.0, 0, zc]]
    physics = {
        "type": "coil_magnetics",
        "plane": next(p["plane"] for p in presets if p["id"] == "longitudinal"),
        "core_layer": "drum",
        "core_layers": ["drum", "sleeve"],
        "shield_layer": "sleeve",
        "coil_layer": "winding",
        "axisym": {"axis_z": zc},
        "grid_nx": 360,                                              # resolve the sleeve gap (>= 3 cells)
        "domain": [[xc - co["half_length"] - m, zc - co["r"] - m], [xc + co["half_length"] + m, zc + co["r"] + m]],
        "body": [[xc - hd, zc - sl["r_out"]], [xc + hd, zc + sl["r_out"]]],
        "ferrite": ferrite,
        "cuts": [{"x": [xc - aw, xc + aw], "z": [zc + wd["r"][0], zc + wd["r"][1]], "dir": 1, "amps": e["turns"]},
                 {"x": [xc - aw, xc + aw], "z": [zc - wd["r"][1], zc - wd["r"][0]], "dir": -1, "amps": e["turns"]}],
        "probe": {"window": [xc, zc], "above": [xc, zc + co["r"] + 0.5]},
        "coil_path": path,
        "coil_depth": 0.0,
        "turns": e["turns"],
        "contacts": {"positive": ["lead_L", "cap_L", "leadout_L"], "negative": ["lead_R", "cap_R", "leadout_R"]},
        "electrical": {k: e[k] for k in ("mu_r", "dcr_ohm", "rated_current_a", "sat_i_half_a", "parasitic_c_f",
                                         "filter_load_ohm", "air_margin_mm")} | {"inductance_h": e["inductance_h"]},
        "camera": {"direction": [0.0, -1.0, 0.1]},
    }

    return Component(
        id=f"{params['component']}_{params['size']}", family=params["component"],
        size=str(params["size"]), name=params["display_name"], variant=variant,
        layers=layers, presets=presets, levels={k: round(v, 6) for k, v in levels.items()},
        explode_step_mm=params["explode"]["step_mm"], params=params, physics=physics,
    )
