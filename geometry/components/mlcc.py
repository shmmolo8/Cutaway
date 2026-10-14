"""Multilayer ceramic capacitor (base-metal electrodes), driven purely by parameters.

CAD frame: X = length (terminations at +/-X), Y = width, Z = up.
Origin = footprint centre; z = 0 = underside of the tin (PCB surface).

Ceramic body = outer box minus the termination stack on every side. Inside it,
`electrode_count` Ni plates are spaced evenly between the top and bottom cover layers;
even plates run to the -X end, odd plates to the +X end (interleaved comb). Each end has
a 5-sided Cu / Ni / Sn cap; the outer tin band ends exactly `band_length` from the end.
"""
from __future__ import annotations

from geometry.core.features import SIDES, five_sided_caps
from geometry.core.layers import (Component, LayerSpec, box, carve, clear_plane,
                                  model_thickness_um, union)


def build(params: dict, variant: str) -> Component:
    dim, lay, desc, ex = params["dimensions"], params["layout"], params["layers"], params["exaggeration"]

    t_true_um = {k: float(v) for k, v in params["thickness_um"].items()}
    t_model_um = {k: model_thickness_um(v, variant, ex) for k, v in t_true_um.items()}
    t = {k: v / 1000.0 for k, v in t_model_um.items()}

    L, W, H = dim["length"], dim["width"], dim["height"]
    t_el, t_cu, t_ni, t_sn = t["inner_electrode"], t["copper"], t["nickel"], t["tin"]
    t_term = t_cu + t_ni + t_sn

    # ---------------------------------------------------------------- ceramic body
    hx, hw = L / 2 - t_term, W / 2 - t_term
    z0, z1 = t_term, H - t_term
    body_h = z1 - z0
    body_h_true = H - 2 * sum(t_true_um[k] for k in ("copper", "nickel", "tin")) / 1000
    if body_h < ex["min_substrate_fraction"] * H:
        raise ValueError(f"{variant}: ceramic body {body_h:.3f} mm too thin; lower exaggeration.max_um")

    n = int(lay["electrode_count"])
    za, zb = z0 + lay["cover_thickness"], z1 - lay["cover_thickness"]
    pitch = (zb - za) / n
    if t_el >= 0.8 * pitch:
        raise ValueError("inner electrodes thicker than their pitch allows")
    ye = hw - lay["side_margin"]
    x_tip = hx - lay["end_margin"]              # electrode tip, measured from the centre

    band = dim["band_length"]
    x_cu = L / 2 - band + t_ni + t_sn           # inner edge of the Cu dip
    if not (x_tip < hx and x_cu - t_ni - t_sn > 0 and ye > 0):
        raise ValueError("inconsistent MLCC layout")

    def spec(id_, kind, envelope, sign=1.0, **kw):
        d = desc[kind]["explode"]["direction"]
        return LayerSpec(id=id_, kind=kind, envelope=envelope,
                         explode_direction=(d[0] * sign, d[1], d[2]),
                         explode_order=int(desc[kind]["explode"]["order"]),
                         thickness_true_um=t_true_um.get(kind, round(body_h_true * 1000, 3)),
                         thickness_model_um=t_model_um.get(kind, round(body_h * 1000, 3)), **kw)

    # ---------------------------------------------------------------- layers (inside-out)
    specs: list[LayerSpec] = []
    for s, sg in SIDES:
        plates = []
        for i in range(n):
            if (i % 2 == 0) != (sg < 0):
                continue
            zc = za + (i + 0.5) * pitch
            plates.append(box(sg * hx, -sg * x_tip, -ye, ye, zc - t_el / 2, zc + t_el / 2))
        spec_ = spec(f"inner_electrodes_{s}", "inner_electrodes", union(*plates), sign=sg,
                     group=f"end_{s}", allow_multiple_solids=True)
        spec_.thickness_true_um = t_true_um["inner_electrode"]
        spec_.thickness_model_um = t_model_um["inner_electrode"]
        specs.append(spec_)

    specs.append(spec("dielectric", "dielectric", box(-hx, hx, -hw, hw, z0, z1), derived=True))

    specs += five_sided_caps(spec, length=L, band=band, body_hx=hx, body_hw=hw, body_z=(z0, z1),
                             films=[("copper", t_cu), ("nickel", t_ni), ("tin", t_sn)])

    layers = carve(specs)

    # ---------------------------------------------------------------- presets (CAD frame)
    z_plate = za + (n // 2 + 0.5) * pitch
    x_band = L / 2 - band / 2
    presets = [
        {"id": "exterior", "label": "Exterior", "plane": None, "explode": 0.0,
         "camera": {"direction": [0.9, -1.3, 1.0]}},
        {"id": "longitudinal", "label": "Longitudinal section (electrode comb)",
         "plane": {"normal": [0, 1, 0], "point": [0, 0, 0]}, "explode": 0.0,
         "camera": {"direction": [0.0, -1.0, 0.12], "fit": "section"}},
        {"id": "transverse", "label": "Transverse section (active stack)",
         "plane": {"normal": [-1, 0, 0], "point": [0, 0, 0]}, "explode": 0.0,
         "camera": {"direction": [1.0, 0.0, 0.12], "fit": "section"}},
        {"id": "transverse_end", "label": "Transverse section (termination)",
         "plane": {"normal": [-1, 0, 0], "point": [x_band, 0, 0]}, "explode": 0.0,
         "camera": {"direction": [1.0, 0.0, 0.12], "fit": "section"}},
        {"id": "plan_electrode", "label": "Plan view: through one electrode",
         "plane": {"normal": [0, 0, -1], "point": [0, 0, z_plate]}, "explode": 0.0,
         "camera": {"direction": [0.0, -0.001, 1.0], "fit": "section"}},
        {"id": "exploded", "label": "Fully exploded", "plane": None, "explode": 1.0,
         "camera": {"direction": [1.0, -1.4, 0.9]}},
        # the electrodes live inside the ceramic, so show the explode on a section too
        {"id": "exploded_section", "label": "Exploded section (electrode combs)",
         "plane": {"normal": [0, 1, 0], "point": [0, 0, 0]}, "explode": 1.0,
         "camera": {"direction": [0.35, -1.0, 0.35]}},
    ]
    for p in presets:
        if p["plane"]:
            p["plane"] = clear_plane(layers, p["plane"])

    # ---------------------------------------------------------------- physics (viewer)
    # 2D electrostatics in the longitudinal section (y = 0, CAD x-z). Plates and the
    # termination-covered surface are held at their end's potential; elsewhere the
    # ceramic surface is zero-flux (eps_r ~ 2500 keeps the field inside the ceramic).
    ids = [l.id for l in layers]
    plates = []
    for i in range(n):
        zc = za + (i + 0.5) * pitch
        left = i % 2 == 0
        plates.append({"x": [-hx, x_tip] if left else [-x_tip, hx],
                       "z": [zc - t_el / 2, zc + t_el / 2], "potential": 1 if left else 0})
    physics = {
        "type": "plate_capacitor",
        "plane": {"normal": [0, 1, 0], "point": [0, 0, 0]},
        "dielectric_layer": "dielectric",
        "domain": [[-hx, z0], [hx, z1]],             # CAD (x, z)
        "plates": plates,
        "band_inner_x": x_cu - t_ni - t_sn,          # termination covers |x| >= this on top/bottom
        "electrode_width": 2 * ye,
        "overlap": {"x": [-x_tip, x_tip], "gap": pitch - t_el, "gaps": n - 1},
        "contacts": {"positive": [i for i in ids if i.endswith("_L")],
                     "negative": [i for i in ids if i.endswith("_R")]},
        "line_count": 2,                             # one mid-gap equipotential per gap
        "electrical": params["electrical"],
        "camera": {"direction": [0.0, -1.0, 0.18]},
    }

    levels = {"body_bottom": z0, "body_top": z1, "active_bottom": za, "active_top": zb,
              "electrode_pitch": pitch, "body_half_length": hx, "body_half_width": hw,
              "electrode_tip": x_tip, "electrode_half_width": ye, "band_inner_x": x_cu - t_ni - t_sn,
              "top": H}
    return Component(
        id=f"{params['component']}_{params['size']}", family=params["component"],
        size=str(params["size"]), name=params["display_name"], variant=variant,
        layers=layers, presets=presets, levels={k: round(v, 6) for k, v in levels.items()},
        explode_step_mm=params["explode"]["step_mm"], params=params, physics=physics,
    )
