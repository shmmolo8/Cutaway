"""Multiturn cermet trimmer potentiometer, top adjust (Bourns 3266W style), by parameters.

CAD frame (KiCad THT convention): origin = pin 1, z = 0 = PCB. The element stands in the XZ
plane at the back: alumina substrate (derived bulk) with a cermet arc, end terminations wrapping
under the substrate onto pins 1 / 3, and a silver collector ring + strip to pin 2. In front, a
rotor (worm wheel with notched rim + shaft) carries the wiper bar that bridges ring and track;
the vertical adjustment screw is the worm. Everything sits in a hollow plastic housing.
The geometry is built with the wiper at `turns_built`; the viewer rotates rotor/wiper/screw.
"""
from __future__ import annotations

import math

from build123d import Axis, Face, Plane, Solid, Wire, extrude

from geometry.core.layers import Component, LayerSpec, box, carve, clear_plane, model_thickness_um, union


def y_cyl(r: float, y0: float, y1: float, x: float, z: float) -> Solid:
    """Cylinder along +y through (x, z)."""
    return Solid.make_cylinder(r, y1 - y0, Plane(origin=(x, y0, z), z_dir=(0, 1, 0)))


def sector(ri: float, ro: float, a0: float, a1: float, y0: float, y1: float, xc: float, zc: float) -> Solid:
    """Annular sector in the XZ plane (angles in degrees from +x towards +z), y0..y1."""
    ring = y_cyl(ro, y0, y1, xc, zc)
    if ri > 0:
        ring = ring.cut(y_cyl(ri, y0, y1, xc, zc))
    big, n = 2 * ro + 1, max(3, int(abs(a1 - a0) / 10) + 2)
    pts = [(xc, y0 - 1, zc)] + [(xc + big * math.cos(math.radians(a0 + (a1 - a0) * i / (n - 1))), y0 - 1,
                                 zc + big * math.sin(math.radians(a0 + (a1 - a0) * i / (n - 1)))) for i in range(n)]
    wedge = extrude(Face(Wire.make_polygon(pts, close=True)), y1 - y0 + 2, dir=(0, 1, 0))
    return ring.intersect(wedge).solids()[0]


def build(params: dict, variant: str) -> Component:
    dim, desc, ex = params["dimensions"], params["layers"], params["exaggeration"]
    t_true_um = {k: float(v) for k, v in params["thickness_um"].items()}
    t_model_um = {k: model_thickness_um(v, variant, ex) for k, v in t_true_um.items()}
    t = {k: v / 1000 for k, v in t_model_um.items()}
    no_t = set(params.get("no_thickness", []))

    def spec(id_, kind, envelope, group=None, tkey=None, **kw):
        d = desc[kind]["explode"]["direction"]
        tk = tkey or kind
        return LayerSpec(
            id=id_, kind=kind, envelope=envelope, explode_direction=tuple(d),
            explode_order=int(desc[kind]["explode"]["order"]), group=group,
            thickness_true_um=None if kind in no_t else t_true_um.get(tk, dim["height"] * 1000),
            thickness_model_um=None if kind in no_t else t_model_um.get(tk, dim["height"] * 1000),
            **kw,
        )

    sb = dim["substrate"]
    yb = sb["y_back"]
    yf = yb - dim["height"]                       # substrate front face: films grow forward of it
    xc, zc = dim["axis"]["x"], dim["axis"]["z"]
    tr, pd, co = dim["track"], dim["pad"], dim["collector"]
    (ri, ro), a0, a1 = tr["r"], tr["from_deg"], tr["to_deg"]
    y_tr, y_co = yf - t["track"], yf - t["conductor"]
    z0 = sb["z"][0]
    pins = dim["pins"]
    rp = pins["diameter"] / 2

    specs = [spec("substrate", "substrate", box(*sb["x"], yf, yb, *sb["z"]), derived=True)]
    specs.append(spec("track", "track", sector(ri, ro, a0, a1, y_tr, yf, xc, zc)))
    # end terminations: a short arc beyond each track end, a link and a strip down to the pin,
    # wrapping under the substrate (pin 1 / R at the from_deg end, pin 3 / L at the to_deg end)
    for s, a_end, a_out, x_pin in (("R", a0, a0 - pd["sector_deg"], pins["x"][0]),
                                   ("L", a1, a1 + pd["sector_deg"], pins["x"][2])):
        arc = sector(ri, ro, min(a_end, a_out), max(a_end, a_out), y_co, yf, xc, zc)
        x_far = xc + (ri + ro) / 2 * math.cos(math.radians(a_out))
        hw = pd["half_width"]
        link = box(min(x_far, x_pin) - hw, max(x_far, x_pin) + hw, y_co, yf, *pd["link_z"])
        strip = box(x_pin - hw, x_pin + hw, y_co, yf, z0, pd["link_z"][1])
        wrap = box(x_pin - hw, x_pin + hw, y_co, yb, z0 - t["conductor"], z0)
        specs.append(spec(f"termination_{s}", "termination", union(arc, link, strip, wrap),
                          group=f"end_{s}", tkey="conductor"))
    ring = y_cyl(co["r"][1], y_co, yf, xc, zc).cut(y_cyl(co["r"][0], y_co, yf, xc, zc))
    sw = co["strip_half_width"]
    specs.append(spec("collector", "collector",
                      union(ring, box(xc - sw, xc + sw, y_co, yf, z0, zc - (co["r"][0] + co["r"][1]) / 2)),
                      group="wiper", tkey="conductor"))

    # rotor + wiper at the built position
    tb, tt_ = dim["turns_built"], dim["turns_total"]
    theta = a1 - (a1 - a0) * tb / tt_               # 0 turns: at the pin 3 end; all turns: pin 1 end
    wp = dim["wiper"]
    wiper = box(xc + wp["r"][0], xc + wp["r"][1], y_tr - wp["thickness"], y_tr, zc - wp["width"] / 2, zc + wp["width"] / 2)
    axis_y = Axis((xc, 0, zc), (0, -1, 0))          # rotating about -y turns +x towards +z
    wiper = wiper.rotate(axis_y, theta)
    ro_ = dim["rotor"]
    wheel = y_cyl(ro_["wheel_radius"], *ro_["wheel_y"], xc, zc)
    nr, nt = ro_["notch"]
    for i in range(ro_["notches"]):
        notch = box(xc + ro_["wheel_radius"] - nr, xc + ro_["wheel_radius"] + 0.1, ro_["wheel_y"][0] - 0.1,
                    ro_["wheel_y"][1] + 0.1, zc - nt / 2, zc + nt / 2)
        wheel = wheel.cut(notch.rotate(axis_y, theta + i * 360 / ro_["notches"]))
    rotor = union(wheel, y_cyl(ro_["shaft_radius"], ro_["wheel_y"][1], y_tr - wp["thickness"], xc, zc))
    specs.append(spec("wiper", "wiper", wiper, group="wiper"))
    specs.append(spec("rotor", "rotor", rotor))

    sc = dim["screw"]
    top = dim["body"]["z"][1]
    head_slot = box(sc["x"] - 1.5, sc["x"] + 1.5, sc["y"] - sc["slot"][0] / 2, sc["y"] + sc["slot"][0] / 2,
                    sc["head_top"] - sc["slot"][1], sc["head_top"] + 0.1)
    screw = union(Solid.make_cylinder(sc["radius"], top - sc["z0"], Plane(origin=(sc["x"], sc["y"], sc["z0"]))),
                  Solid.make_cylinder(sc["head_radius"], sc["head_top"] - top, Plane(origin=(sc["x"], sc["y"], top))))
    gap = abs(sc["x"] - xc) - sc["radius"] - ro_["wheel_radius"]
    if gap <= 0.01:
        raise ValueError(f"worm and wheel overlap (gap {gap:.3f} mm)")
    specs.append(spec("screw", "screw", screw, cuts=[head_slot]))
    w = dim["wall"]
    orr, oh = dim["oring"]["r"], dim["oring"]["height"]
    oring = Solid.make_cylinder(orr[1], oh, Plane(origin=(sc["x"], sc["y"], top - w - oh)))
    specs.append(spec("oring", "oring", oring))

    # pins: 1 and 3 up to the termination wraps; 2 bends back to press on the collector strip
    for s, i in (("R", 0), ("L", 2)):
        specs.append(spec(f"lead_{s}", "lead", Solid.make_cylinder(
            rp, pins["below"] + z0 - t["conductor"], Plane(origin=(pins["x"][i], pins["y"][i], -pins["below"]))),
            group=f"end_{s}"))
    zc2 = dim["pin2_contact_z"]
    pin2 = union(Solid.make_cylinder(rp, pins["below"] + zc2, Plane(origin=(pins["x"][1], pins["y"][1], -pins["below"]))),
                 y_cyl(rp, pins["y"][1], y_co, pins["x"][1], zc2))
    specs.append(spec("lead_wiper", "lead", pin2, group="wiper"))

    bx, by, bz = dim["body"]["x"], dim["body"]["y"], dim["body"]["z"]
    housing = box(*bx, *by, *bz).cut(box(bx[0] + w, bx[1] - w, by[0] + w, by[1] - w, bz[0] + w, bz[1] - w))
    specs.append(spec("housing", "housing", housing))

    layers = carve(specs)

    # ---------------------------------------------------------------- presets (CAD frame)
    yfilm_mid = (y_tr + yf) / 2
    presets = [
        {"id": "exterior", "label": "Exterior", "plane": None, "explode": 0.0,
         "camera": {"direction": [0.8, -1.3, 0.9]}},
        {"id": "longitudinal", "label": "Section through screw and rotor",
         "plane": {"normal": [0, 0, -1], "point": [xc, 0, zc]}, "explode": 0.0,
         "camera": {"direction": [0.0, -0.4, 1.0], "fit": "section"}},
        {"id": "element", "label": "The element (housing and rotor hidden)", "plane": None, "explode": 0.0,
         "hide": ["housing", "rotor"], "camera": {"direction": [0.0, -1.0, 0.15]}},
        {"id": "front_section", "label": "Section just in front of the track",
         "plane": {"normal": [0, 1, 0], "point": [xc, y_tr - wp["thickness"] / 2, zc]}, "explode": 0.0,
         "camera": {"direction": [0.0, -1.0, 0.1], "fit": "section"}},
        {"id": "exploded", "label": "Fully exploded", "plane": None, "explode": 1.0,
         "camera": {"direction": [0.9, -1.3, 0.7]}},
    ]
    for preset in presets:
        if preset["plane"]:
            preset["plane"] = clear_plane(layers, preset["plane"])

    levels = {"axis_x": xc, "axis_z": zc, "film_front_y": y_tr, "substrate_front_y": yf, "wiper_deg": theta}

    # ---------------------------------------------------------------- physics (viewer)
    # Sheet conduction on the arc (solved in the XZ plane, solver (x, y) = CAD (x, z)); pin 1 is
    # driven, pin 3 grounded, the wiper taps the track. Rotation specs let the screw-turn slider
    # turn the drawn rotor/wiper about the track axis and the screw about its own axis.
    ids = [l.id for l in layers]
    physics = {
        "type": "rotary_track",
        "film_layer": "track",
        "film_y": y_tr,
        "domain": [[xc - ro - 0.05, zc - ro - 0.05], [xc + ro + 0.05, zc + ro + 0.05]],
        "contact_x": [0.0, 0.0],
        "center": [xc, zc],
        "track": {"r": [ri, ro], "from_deg": a0, "to_deg": a1, "pad_deg": pd["sector_deg"]},
        "wiper": {"r": (ri + ro) / 2, "half_width": wp["width"] / 2},
        "turns": {"total": tt_, "built": tb},
        "rotate": [
            {"ids": ["rotor", "wiper"], "center": [xc, 0.0, zc], "plane": "xz", "deg_per_turn": -(a1 - a0) / tt_},
            {"ids": ["screw"], "center": [sc["x"], sc["y"], 0.0], "plane": "xy", "deg_per_turn": 360.0},
        ],
        "contacts": {"positive": ["termination_R", "lead_R"], "negative": ["termination_L", "lead_L"],
                     "wiper": ["wiper", "collector", "lead_wiper"]},
        "thermal_layers": ["substrate"],
        "fade_layers": ["housing", "rotor", "screw", "oring"],       # see-through while powered
        "hide_layers": [],
        "electrical": params["electrical"],
        "camera": {"direction": [0.0, -1.0, 0.12],
                   "box": [[sb["x"][0], yf, sb["z"][0]], [sb["x"][1], yb, sb["z"][1]]]},
    }
    assert {i for g in physics["contacts"].values() for i in g} <= set(ids)

    return Component(
        id=f"{params['component']}_{params['size']}", family=params["component"],
        size=str(params["size"]), name=params["display_name"], variant=variant,
        layers=layers, presets=presets, levels={k: round(v, 6) for k, v in levels.items()},
        explode_step_mm=params["explode"]["step_mm"], params=params, physics=physics,
    )
