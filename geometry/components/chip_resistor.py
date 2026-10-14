"""Thick-film chip resistor (0402 / 0603 / 1206 ... driven purely by parameters).

CAD frame: X = length (terminations at +/-X), Y = width, Z = up.
Origin = footprint centre; z = 0 = underside of the tin (PCB surface).

Z stack (bottom -> top), all derived from the parameter file:
    tin | nickel | bottom Ag electrode | alumina substrate | Ag-Pd top electrode
    | RuO2 | glass | epoxy (flat top at z = H)
The substrate thickness is whatever is left so the overall height equals H.
"""
from __future__ import annotations

from build123d import Align, Location, Text, extrude

from geometry.core.layers import (Component, LayerSpec, box, carve, clear_plane,
                                  model_thickness_um, union)

SIDES = (("L", -1.0), ("R", 1.0))


def build(params: dict, variant: str) -> Component:
    dim, lay, trim = params["dimensions"], params["layout"], params["trim"]
    desc = params["layers"]
    ex = params["exaggeration"]

    # ---------------------------------------------------------------- thicknesses (mm)
    t_true_um = {k: float(v) for k, v in params["thickness_um"].items()}
    t_model_um = {k: model_thickness_um(v, variant, ex) for k, v in t_true_um.items()}
    t = {k: v / 1000.0 for k, v in t_model_um.items()}

    L, W, H = dim["length"], dim["width"], dim["height"]
    lt, lb = dim["top_electrode_length"], dim["bottom_electrode_length"]

    t_sn, t_ni, t_nc = t["tin"], t["nickel"], t["edge_electrode"]
    t_be, t_te, t_r = t["bottom_electrode"], t["top_electrode"], t["resistive"]
    t_g, t_oc = t["glass_primary"], t["overcoat_secondary"]

    mk = params.get("marking", {})
    marked = bool(mk.get("enabled"))

    def substrate_thickness(tt: dict[str, float]) -> float:
        bottom = tt["tin"] + tt["nickel"] + tt["bottom_electrode"]
        top = tt["top_electrode"] + tt["resistive"] + tt["glass_primary"] + tt["overcoat_secondary"]
        # printed marking sits on the epoxy and must stay within H
        return H - bottom - top - (tt["marking"] if marked else 0.0)

    t_sub = substrate_thickness(t)
    t_sub_true = substrate_thickness({k: v / 1000 for k, v in t_true_um.items()})
    if t_sub < ex["min_substrate_fraction"] * H:
        raise ValueError(
            f"{variant}: substrate {t_sub:.3f} mm < {ex['min_substrate_fraction']:.0%} of H; "
            "lower exaggeration.max_um")

    # ---------------------------------------------------------------- stations
    hx = L / 2 - (t_nc + t_ni + t_sn)          # substrate half-length
    hw = W / 2                                  # substrate half-width (no side wrap)
    be_bot = t_sn + t_ni
    sub_bot = be_bot + t_be
    sub_top = sub_bot + t_sub
    te_top = sub_top + t_te
    oc_top = te_top + t_r + t_g + t_oc          # == H (or H - marking) by construction
    term_top = te_top + t_ni + t_sn             # top of plated termination
    t_mk = t["marking"] if marked else 0.0
    assert abs(oc_top + t_mk - H) < 1e-9 and term_top < oc_top

    g = hx - lt                                 # gap half-length between top electrodes
    xr = g + lay["resistive_overlap"]
    yr = hw - lay["resistive_side_margin"]
    xg, yg = xr + lay["glass_margin"], yr + lay["glass_margin"]
    xoc = xg + lay["overcoat_margin_x"]
    yoc = hw - lay["overcoat_side_margin"]
    if g <= 0:
        raise ValueError("top electrodes overlap")
    if hx - xoc < lay["min_exposed_electrode"]:
        raise ValueError(f"only {hx - xoc:.3f} mm of top electrode left outside the overcoat")
    if yoc <= yg:
        raise ValueError("overcoat narrower than glass")

    # ---------------------------------------------------------------- laser L-cut
    k = trim["kerf_width"]
    sy = -1.0 if trim.get("from_edge", "-Y") == "-Y" else 1.0
    x0 = trim["plunge_x_fraction"] * g
    run = trim["run_fraction"] * g
    y_edge = sy * (yg + k)                      # start outside the glass
    y_leg = sy * (yr - trim["plunge_fraction"] * 2 * yr)    # centreline of the 90-degree leg
    y_tip = y_leg - sy * k / 2                              # deepest point of the plunge
    z_kerf = (sub_top, sub_top + t_r + t_g)
    plunge = box(x0 - k / 2, x0 + k / 2, y_edge, y_tip, *z_kerf)
    leg = box(x0 - k / 2, x0 + run, y_leg + sy * k / 2, y_tip, *z_kerf)
    kerf = union(plunge, leg)
    flat_limit = g - t_r - t_g                  # keep the trim on the flat part of the film
    if x0 - k / 2 < -flat_limit or x0 + run > flat_limit:
        raise ValueError("laser trim runs onto the electrode step")

    # ---------------------------------------------------------------- layer specs
    def spec(id_, kind, envelope, sign=1.0, group=None, **kw):
        d = desc[kind]["explode"]["direction"]
        return LayerSpec(
            id=id_, kind=kind, envelope=envelope,
            explode_direction=(d[0] * sign, d[1], d[2]),
            explode_order=int(desc[kind]["explode"]["order"]),
            group=group,
            thickness_true_um=t_true_um.get(kind, round(t_sub_true * 1000, 3)),
            thickness_model_um=t_model_um.get(kind, round(t_sub * 1000, 3)),
            **kw,
        )

    specs: list[LayerSpec] = [spec("substrate", "substrate",
                                   box(-hx, hx, -hw, hw, sub_bot, sub_top), derived=True)]
    for s, sg in SIDES:
        specs.append(spec(f"bottom_electrode_{s}", "bottom_electrode",
                          box(sg * hx, sg * (hx - lb), -hw, hw, be_bot, sub_bot),
                          group=f"termination_{s}"))
    for s, sg in SIDES:
        specs.append(spec(f"top_electrode_{s}", "top_electrode",
                          box(sg * hx, sg * (hx - lt), -hw, hw, sub_top, te_top),
                          group=f"termination_{s}"))

    # RuO2: flat in the gap, climbing each electrode's inner face onto its top.
    res_env = union(box(-xr, xr, -yr, yr, sub_top, sub_top + t_r),
                    *(box(sg * (g - t_r), sg * xr, -yr, yr, sub_top, te_top + t_r)
                      for _, sg in SIDES))
    specs.append(spec("resistive", "resistive", res_env, cuts=[kerf]))

    # Glass: conformal over the RuO2, a margin larger on every side.
    glass_env = union(box(-xg, xg, -yg, yg, sub_top, sub_top + t_r + t_g),
                      *(box(sg * (g - t_r - t_g), sg * xg, -yg, yg, sub_top, te_top + t_r + t_g)
                        for _, sg in SIDES))
    specs.append(spec("glass_primary", "glass_primary", glass_env, cuts=[kerf]))

    # Epoxy: flat-topped block; carving makes it fill the trim kerf and hug the glass.
    specs.append(spec("overcoat_secondary", "overcoat_secondary",
                      box(-xoc, xoc, -yoc, yoc, sub_top, oc_top)))

    x_nc = hx + t_nc
    x_ni = x_nc + t_ni
    for s, sg in SIDES:
        specs.append(spec(f"edge_electrode_{s}", "edge_electrode",
                          box(sg * hx, sg * x_nc, -hw, hw, be_bot, te_top),
                          sign=sg, group=f"termination_{s}"))
    for s, sg in SIDES:
        env = union(
            box(sg * x_nc, sg * x_ni, -hw, hw, be_bot - t_ni, te_top + t_ni),    # end face
            box(sg * xoc, sg * x_ni, -hw, hw, te_top, te_top + t_ni),            # top wrap
            box(sg * (hx - lb), sg * x_ni, -hw, hw, be_bot - t_ni, be_bot),       # bottom wrap
        )
        specs.append(spec(f"nickel_{s}", "nickel", env, sign=sg, group=f"termination_{s}"))
    for s, sg in SIDES:
        env = union(
            box(sg * x_ni, sg * L / 2, -hw, hw, 0.0, term_top),
            box(sg * xoc, sg * L / 2, -hw, hw, te_top + t_ni, term_top),
            box(sg * (hx - lb), sg * L / 2, -hw, hw, 0.0, t_sn),
        )
        specs.append(spec(f"tin_{s}", "tin", env, sign=sg, group=f"termination_{s}"))

    if marked:
        glyphs = Text(mk["text"], font_size=mk["font_fraction"] * 2 * yoc, font=mk.get("font", "DejaVu Sans"),
                      align=(Align.CENTER, Align.CENTER))
        env = extrude(glyphs, amount=t_mk).moved(Location((0, 0, oc_top)))
        gb = env.bounding_box()
        if gb.max.X > xoc or gb.min.X < -xoc or gb.max.Y > yoc or gb.min.Y < -yoc:
            raise ValueError("marking does not fit on the overcoat")
        specs.append(spec("marking", "marking", env, allow_multiple_solids=True))

    layers = carve(specs)

    # ---------------------------------------------------------------- viewer presets (CAD frame)
    z_res_mid = sub_top + t_r / 2
    z_overlap_mid = te_top + t_r / 2
    x_term = (xoc + hx) / 2
    presets = [
        {"id": "exterior", "label": "Exterior", "plane": None, "explode": 0.0,
         "camera": {"direction": [0.9, -1.3, 1.0]}},
        {"id": "longitudinal", "label": "Longitudinal section",
         "plane": {"normal": [0, 1, 0], "point": [0, 0, 0]}, "explode": 0.0,
         "camera": {"direction": [0.0, -1.0, 0.12], "fit": "section"}},
        {"id": "transverse", "label": "Transverse section (termination)",
         "plane": {"normal": [-1, 0, 0], "point": [x_term, 0, 0]}, "explode": 0.0,
         "camera": {"direction": [1.0, 0.0, 0.12], "fit": "section"}},
        {"id": "plan_trim", "label": "Plan view: resistive mid-height (trim cut)",
         "plane": {"normal": [0, 0, -1], "point": [0, 0, z_res_mid]}, "explode": 0.0,
         "camera": {"direction": [0.0, -0.001, 1.0], "fit": "section"}},
        {"id": "plan_overlap", "label": "Plan view: electrode overlap",
         "plane": {"normal": [0, 0, -1], "point": [0, 0, z_overlap_mid]}, "explode": 0.0,
         "camera": {"direction": [0.0, -0.001, 1.0], "fit": "section"}},
        {"id": "exploded", "label": "Fully exploded", "plane": None, "explode": 1.0,
         "camera": {"direction": [1.0, -1.4, 0.9]}},
    ]

    for preset in presets:
        if preset["plane"]:
            preset["plane"] = clear_plane(layers, preset["plane"])

    levels = {
        "tin_bottom": 0.0, "bottom_electrode_bottom": be_bot, "substrate_bottom": sub_bot,
        "substrate_top": sub_top, "top_electrode_top": te_top, "termination_top": term_top,
        "overcoat_top": oc_top, "top": oc_top + t_mk, "substrate_half_length": hx, "gap_half_length": g,
        "resistive_half_length": xr, "resistive_half_width": yr,
        "overcoat_half_length": xoc,
    }
    # ---------------------------------------------------------------- physics (viewer)
    # 2D sheet conduction in the RuO2 film. Film over an electrode is shorted by the metal,
    # so |x| >= g is held at the electrode potential; the kerf is an insulating boundary.
    ids = [l.id for l in layers]
    side = lambda s: [i for i in ids if i.endswith(f"_{s}") and i not in ("resistive",)]
    fade = [i for i in ("glass_primary", "overcoat_secondary") if i in ids]
    elec = params["electrical"]
    physics = {
        "type": "sheet_conduction",
        "film_layer": "resistive",
        "domain": [[-xr, -yr], [xr, yr]],
        "contact_x": [-g, g],                       # film at x <= -g is +, at x >= g is 0 V
        "surface": {"z_low": sub_top + t_r, "z_high": te_top + t_r, "x_step": g - t_r},
        "z_substrate": [sub_bot, sub_top],
        "trim": {"x0": x0, "kerf": k, "sy": sy, "y_film_edge": sy * yr, "y_tip": y_tip,
                 "leg_end_x": x0 + run, "leg_end_x_max": flat_limit},
        "contacts": {"positive": side("L"), "negative": side("R")},
        "thermal_layers": [i for i in ids if i not in ("resistive", "marking", *fade)],
        "fade_layers": fade,                          # made translucent while powered
        "hide_layers": [i for i in ("marking",) if i in ids],
        "electrical": elec,
        "camera": {"direction": [0.12, -0.55, 1.0]},
    }

    return Component(
        id=f"{params['component']}_{params['size']}", family=params["component"],
        size=str(params["size"]), name=params["display_name"], variant=variant,
        layers=layers, presets=presets, levels={k: round(v, 6) for k, v in levels.items()},
        explode_step_mm=params["explode"]["step_mm"], params=params, physics=physics,
    )
