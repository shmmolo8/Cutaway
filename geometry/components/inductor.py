"""Multilayer ferrite chip inductor, driven purely by parameters.

CAD frame: X = length (terminations at +/-X), Y = width, Z = up (= coil axis).
Origin = footprint centre; z = 0 = underside of the tin (PCB surface).

Ferrite body = outer box minus the termination stack on every side. The coil is a
rectangular helix: `layers` printed Ag traces, each running `turn_per_layer` of a turn
around the same rectangle, joined by vias where one trace ends and the next begins
(same rotation sense throughout). The bottom trace starts mid-way along the -X side and
leaves through a lead to the -X end face; the top trace ends mid-way along the +X side
and leaves to the +X end face. Ends get 5-sided Ag / Ni / Sn caps.
"""
from __future__ import annotations

from geometry.core.features import five_sided_caps, rect_arc_boxes, rect_point
from geometry.core.layers import (Component, LayerSpec, box, carve, clear_plane,
                                  model_thickness_um, union)


def build(params: dict, variant: str) -> Component:
    dim, coil, desc, ex = params["dimensions"], params["coil"], params["layers"], params["exaggeration"]

    t_true_um = {k: float(v) for k, v in params["thickness_um"].items()}
    t_model_um = {k: model_thickness_um(v, variant, ex) for k, v in t_true_um.items()}
    t = {k: v / 1000.0 for k, v in t_model_um.items()}

    L, W, H = dim["length"], dim["width"], dim["height"]
    t_c, t_ag, t_ni, t_sn = t["coil"], t["silver_termination"], t["nickel"], t["tin"]
    t_term = t_ag + t_ni + t_sn

    # ---------------------------------------------------------------- ferrite body
    hx, hw = L / 2 - t_term, W / 2 - t_term
    z0, z1 = t_term, H - t_term
    body_h = z1 - z0
    body_h_true = H - 2 * sum(t_true_um[k] for k in ("silver_termination", "nickel", "tin")) / 1000
    if body_h < ex["min_substrate_fraction"] * H:
        raise ValueError(f"{variant}: ferrite body {body_h:.3f} mm too thin; lower exaggeration.max_um")

    # ---------------------------------------------------------------- coil
    n, f, w = int(coil["layers"]), float(coil["turn_per_layer"]), coil["trace_width"]
    cx = hx - coil["end_margin"] - w / 2        # trace centre-line rectangle
    cy = hw - coil["side_margin"] - w / 2
    za, zb = z0 + coil["cover_thickness"], z1 - coil["cover_thickness"]
    pitch = (zb - za) / n
    if cx <= w or cy <= w or t_c >= 0.8 * pitch:
        raise ValueError("coil does not fit the body")
    P = 4 * (cx + cy)
    s0 = 4 * cx + 3 * cy                        # mid-way along the -X side
    ex_, ey_ = rect_point(s0 + n * f * P, cx, cy)
    if abs(ex_ - cx) > 1e-9 or abs(ey_) > 1e-9:
        raise ValueError("coil must end mid-way along the +X side (layers x turn_per_layer = k + 0.5)")

    zc = [za + (i + 0.5) * pitch for i in range(n)]
    parts = []
    for i in range(n):
        parts += rect_arc_boxes(cx, cy, s0 + i * f * P, f * P, w, zc[i] - t_c / 2, zc[i] + t_c / 2)
    for i in range(n - 1):                      # vias between consecutive traces
        px, py = rect_point(s0 + (i + 1) * f * P, cx, cy)
        parts.append(box(px - w / 2, px + w / 2, py - w / 2, py + w / 2,
                         zc[i] - t_c / 2, zc[i + 1] + t_c / 2))
    parts.append(box(-hx, -cx, -w / 2, w / 2, zc[0] - t_c / 2, zc[0] + t_c / 2))      # lead to -X
    parts.append(box(cx, hx, -w / 2, w / 2, zc[-1] - t_c / 2, zc[-1] + t_c / 2))     # lead to +X

    def spec(id_, kind, envelope, sign=1.0, **kw):
        d = desc[kind]["explode"]["direction"]
        return LayerSpec(id=id_, kind=kind, envelope=envelope,
                         explode_direction=(d[0] * sign, d[1], d[2]),
                         explode_order=int(desc[kind]["explode"]["order"]),
                         thickness_true_um=t_true_um.get(kind, round(body_h_true * 1000, 3)),
                         thickness_model_um=t_model_um.get(kind, round(body_h * 1000, 3)), **kw)

    specs = [spec("coil", "coil", union(*parts)),
             spec("ferrite", "ferrite", box(-hx, hx, -hw, hw, z0, z1), derived=True)]
    specs += five_sided_caps(spec, length=L, band=dim["band_length"], body_hx=hx, body_hw=hw,
                             body_z=(z0, z1),
                             films=[("silver_termination", t_ag), ("nickel", t_ni), ("tin", t_sn)])
    layers = carve(specs)

    # ---------------------------------------------------------------- presets (CAD frame)
    presets = [
        {"id": "exterior", "label": "Exterior", "plane": None, "explode": 0.0,
         "camera": {"direction": [0.9, -1.3, 1.0]}},
        {"id": "coil", "label": "Coil only (ferrite hidden)", "plane": None, "explode": 0.0,
         "hide": ["ferrite"], "camera": {"direction": [0.8, -1.2, 1.1]}},
        {"id": "longitudinal", "label": "Longitudinal section (turns and leads)",
         "plane": {"normal": [0, 1, 0], "point": [0, 0, 0]}, "explode": 0.0,
         "camera": {"direction": [0.0, -1.0, 0.12], "fit": "section"}},
        {"id": "transverse", "label": "Transverse section (coil window)",
         "plane": {"normal": [-1, 0, 0], "point": [0, 0, 0]}, "explode": 0.0,
         "camera": {"direction": [1.0, 0.0, 0.12], "fit": "section"}},
        {"id": "plan_layer", "label": "Plan view: through one coil sheet",
         "plane": {"normal": [0, 0, -1], "point": [0, 0, zc[n // 2]]}, "explode": 0.0,
         "camera": {"direction": [0.0, -0.001, 1.0], "fit": "section"}},
        {"id": "exploded", "label": "Fully exploded", "plane": None, "explode": 1.0,
         "hide": ["ferrite"], "camera": {"direction": [1.0, -1.4, 0.9]}},
    ]
    for p in presets:
        if p["plane"]:
            p["plane"] = clear_plane(layers, p["plane"])

    # ---------------------------------------------------------------- physics (viewer)
    # 2D magnetostatics in the section through the coil axis (y = 0, CAD x-z). Coil sides
    # running along y pierce this plane; the trace is followed in increasing arc length
    # (current enters from the -X terminal), so +X sides carry +y current, -X sides -y.
    s_mid = {1.0: 2 * cx + cy, -1.0: 4 * cx + 3 * cy}        # mid-point of the +X / -X sides
    cuts = []
    for i in range(n):
        a, b = s0 + i * f * P, s0 + (i + 1) * f * P
        for side, sm in s_mid.items():
            k0 = int((a - sm) // P) + 1
            if any(a + 1e-9 < sm + k * P < b - 1e-9 for k in range(k0 - 1, k0 + 3)):
                cuts.append({"x": [side * cx - w / 2, side * cx + w / 2],
                             "z": [zc[i] - t_c / 2, zc[i] + t_c / 2], "dir": side})
    # a sheet junction (via) that lands exactly on a mid-side point is one crossing there,
    # carried by the via between the two sheets
    for j in range(1, n):
        sb = s0 + j * f * P
        for side, sm in s_mid.items():
            if abs(((sb - sm) / P) - round((sb - sm) / P)) < 1e-9:
                cuts.append({"x": [side * cx - w / 2, side * cx + w / 2],
                             "z": [zc[j - 1] - t_c / 2, zc[j] + t_c / 2], "dir": side})
    # centre-line of the whole conductor (lead, sheets, vias, lead) for the current particles
    corners = [0, 2 * cx, 2 * cx + 2 * cy, 4 * cx + 2 * cy]
    path = [[-hx, 0.0, zc[0]]]
    for i in range(n):
        a, b = s0 + i * f * P, s0 + (i + 1) * f * P
        pts = [a] + sorted(c + k * P for c in corners for k in range(int(a // P) - 1, int(b // P) + 2)
                           if a < c + k * P < b) + [b]
        path += [[*rect_point(s, cx, cy), zc[i]] for s in pts]
        if i < n - 1:
            path.append([*rect_point(b, cx, cy), zc[i + 1]])
    path.append([hx, 0.0, zc[-1]])
    m = params["electrical"]["air_margin_mm"]
    ids = [l.id for l in layers]
    physics = {
        "type": "coil_magnetics",
        "plane": {"normal": [0, 1, 0], "point": [0, 0, 0]},
        "core_layer": "ferrite",
        "coil_layer": "coil",
        "domain": [[-L / 2 - m, -m], [L / 2 + m, H + m]],     # CAD (x, z), includes air
        "body": [[-hx, z0], [hx, z1]],                       # ferrite region
        "cuts": cuts,
        "coil_path": [[round(v, 6) for v in p_] for p_ in path],
        "coil_depth": 2 * cy + w,                            # length of the y-running sides
        "turns": n * f,
        "contacts": {"positive": [i for i in ids if i.endswith("_L")],
                     "negative": [i for i in ids if i.endswith("_R")]},
        "electrical": params["electrical"],
        "camera": {"direction": [0.0, -1.0, 0.18]},
    }

    levels = {"body_bottom": z0, "body_top": z1, "coil_bottom": za, "coil_top": zb,
              "coil_pitch": pitch, "coil_half_length": cx, "coil_half_width": cy,
              "body_half_length": hx, "body_half_width": hw, "top": H}
    return Component(
        id=f"{params['component']}_{params['size']}", family=params["component"],
        size=str(params["size"]), name=params["display_name"], variant=variant,
        layers=layers, presets=presets, levels={k: round(v, 6) for k, v in levels.items()},
        explode_step_mm=params["explode"]["step_mm"], params=params, physics=physics,
    )
