"""Moulded SMD tantalum capacitor (MnO2 cathode), driven purely by parameters.

CAD frame: origin = footprint centre, z = 0 = PCB, pin 1 = anode (+) at -X.
Build-up (placement order): tantalum wire | porous pellet (derived: the fixed stack box minus
every cathode layer) | Ta2O5 skin | PTFE washer at the wire exit | MnO2 | carbon | silver |
silver epoxy | lead frames (internal strip + end face + foot, one solid per side) |
polarity band | epoxy mould. Each cathode layer is the box one thickness further out, so they
are exact shells; the washer keeps them off the wire.
"""
from __future__ import annotations

from build123d import Plane, Solid

from geometry.core.layers import Component, LayerSpec, box, carve, clear_plane, model_thickness_um, union

SIDES = (("L", -1.0), ("R", 1.0))
SHELLS = ("oxide", "mno2", "carbon", "silver")      # inside -> out


def build(params: dict, variant: str) -> Component:
    dim, desc, ex = params["dimensions"], params["layers"], params["exaggeration"]
    t_true_um = {k: float(v) for k, v in params["thickness_um"].items()}
    t_model_um = {k: model_thickness_um(v, variant, ex) for k, v in t_true_um.items()}
    t = {k: v / 1000 for k, v in t_model_um.items()}
    tt = {k: v / 1000 for k, v in t_true_um.items()}
    no_t = set(params.get("no_thickness", []))

    st = dim["stack"]
    (sx0, sx1), sy, (sz0, sz1) = st["x"], st["y"], st["z"]
    if abs(dim["height"] - (sz1 - sz0)) > 1e-9:
        raise ValueError("dimensions.height must equal the stack height")
    total = sum(t[k] for k in SHELLS)
    pel_h, pel_h_true = (sz1 - sz0) - 2 * total, (sz1 - sz0) - 2 * sum(tt[k] for k in SHELLS)
    if pel_h < ex["min_substrate_fraction"] * dim["height"]:
        raise ValueError(f"{variant}: pellet {pel_h:.3f} mm too thin")

    def shell_box(k: int) -> object:
        """Box out to the outside of shell k (k = -1: the pellet itself)."""
        g = total - sum(t[s] for s in SHELLS[: k + 1])          # what is still outside
        return box(sx0 + g, sx1 - g, -sy + g, sy - g, sz0 + g, sz1 - g)

    def spec(id_, kind, envelope, sign=1.0, group=None, **kw):
        d = desc[kind]["explode"]["direction"]
        return LayerSpec(
            id=id_, kind=kind, envelope=envelope,
            explode_direction=(d[0] * sign, d[1], d[2]),
            explode_order=int(desc[kind]["explode"]["order"]), group=group,
            thickness_true_um=None if kind in no_t else t_true_um.get(kind, round(pel_h_true * 1000, 3)),
            thickness_model_um=None if kind in no_t else t_model_um.get(kind, round(pel_h * 1000, 3)),
            **kw,
        )

    zc = (sz0 + sz1) / 2
    px0 = sx0 + total                                           # pellet -x face (wire exit)
    rw = dim["wire_diameter"] / 2
    wx0 = dim["wire_end_x"]
    wire = Solid.make_cylinder(rw, px0 + dim["wire_embed"] - wx0, Plane(origin=(wx0, 0, zc), z_dir=(1, 0, 0)))
    specs = [spec("wire", "wire", wire, group="terminal_L"),
             spec("pellet", "pellet", shell_box(-1), derived=True)]
    wa = dim["washer"]
    for k, s in enumerate(SHELLS):
        specs.append(spec(s, s, shell_box(k)))
        if s == "oxide":                                         # washer sits on the oxide, around the wire
            specs.append(spec("washer", "washer", box(sx0 - wa["out"], px0 - t["oxide"], -wa["half"], wa["half"],
                                                      zc - wa["half"], zc + wa["half"])))
    se = dim["silver_epoxy"]
    cs = dim["cathode_strip"]
    specs.append(spec("silver_epoxy", "silver_epoxy",
                      box(se["x"][0], se["x"][1], -se["half_width"], se["half_width"], cs["z"][1], sz0)))

    # lead frames: end face + foot outside the mould, internal strip to the wire / under the pellet
    L, mx, tm = dim["length"], dim["mould_x"], dim["term"]
    h = zc - rw                                                  # anode strip top = wire bottom (weld)
    an = dim["anode_strip"]
    if not (an["x_in"] > wx0 and h - an["thickness"] > dim["mould_bottom"]):
        raise ValueError("anode strip must reach under the wire end, inside the mould")
    frames = {
        "L": union(box(-L / 2, -mx, -tm["half_width"], tm["half_width"], 0, h),
                   # the wire sits half-sunk in the strip (weld): a tangent touch would leave a
                   # zero-thickness sliver of mould between them
                   box(-mx, an["x_in"], -an["half_width"], an["half_width"], h + rw / 2 - an["thickness"], h + rw / 2),
                   box(-L / 2, -L / 2 + tm["foot"], -tm["half_width"], tm["half_width"], 0, tm["thickness"])),
        "R": union(box(mx, L / 2, -tm["half_width"], tm["half_width"], 0, h),
                   box(cs["x_in"], mx, -cs["half_width"], cs["half_width"], *cs["z"]),
                   box(L / 2 - tm["foot"], L / 2, -tm["half_width"], tm["half_width"], 0, tm["thickness"])),
    }
    for s, sg in SIDES:
        specs.append(spec(f"lead_frame_{s}", "lead_frame", frames[s], sign=sg, group=f"terminal_{s}"))
    W, top = dim["width"], dim["body_top"]
    bx = dim["band"]["x"]
    specs.append(spec("band", "band", box(bx[0], bx[1], -W / 2, W / 2, top - t["band"], top)))
    specs.append(spec("mould", "mould", box(-mx, mx, -W / 2, W / 2, dim["mould_bottom"], top)))

    layers = carve(specs)

    # ---------------------------------------------------------------- presets (CAD frame)
    presets = [
        {"id": "exterior", "label": "Exterior", "plane": None, "explode": 0.0,
         "camera": {"direction": [0.8, -1.3, 0.9]}},
        {"id": "longitudinal", "label": "Longitudinal section (anode, wire, cathode layers)",
         "plane": {"normal": [0, 1, 0], "point": [0, 0, zc]}, "explode": 0.0,
         "camera": {"direction": [0.0, -1.0, 0.12], "fit": "section"}},
        {"id": "transverse", "label": "Transverse section (pellet and its layers)",
         "plane": {"normal": [-1, 0, 0], "point": [0.05, 0, zc]}, "explode": 0.0,
         "camera": {"direction": [1.0, -0.2, 0.15], "fit": "section"}},
        {"id": "inside", "label": "Inside (mould hidden)", "plane": None, "explode": 0.0,
         "hide": ["mould", "band"], "camera": {"direction": [0.8, -1.3, 0.9]}},
        {"id": "exploded", "label": "Fully exploded", "plane": None, "explode": 1.0,
         "camera": {"direction": [0.9, -1.3, 0.8]}},
    ]
    for preset in presets:
        if preset["plane"]:
            preset["plane"] = clear_plane(layers, preset["plane"])

    levels = {"pellet_x0": px0, "pellet_x1": sx1 - total, "stack_z_mid": zc, "pellet_height": pel_h}

    # ---------------------------------------------------------------- physics (viewer)
    # Same computed physics as the aluminium electrolytic (oxide ~36 nm: field = V/d).
    e = dict(params["electrical"])
    T = sum(tt[k] for k in SHELLS)
    lx, ly, lz = (sx1 - sx0) - 2 * T, 2 * sy - 2 * T, pel_h_true      # true pellet
    e["ref_length_mm"] = round(lx, 4)
    e["ref_area_mm2"] = round(2 * (lx * ly + lx * lz + ly * lz), 4)   # the pellet's outside
    pellet_x1 = sx1 - total
    physics = {
        "type": "electrolytic",
        "plane": next(q["plane"] for q in presets if q["id"] == "longitudinal"),
        "dielectric_layer": "oxide",
        "contacts": {"positive": ["wire", "pellet", "lead_frame_L"],
                     "negative": ["mno2", "carbon", "silver", "silver_epoxy", "lead_frame_R"]},
        "electrical": e,
        "oxide_um_true": t_true_um["oxide"],
        # the pellet-length slider shortens the pellet stack from its cathode (+x) end
        "cut_layers": ["pellet", "oxide", "mno2", "carbon", "silver"],
        "cut_color_layer": "mould",
        "cut": {"mode": "axis", "center": [px0, 0.0], "axis": [1.0, 0.0], "r_in": 0.0, "r_out": pellet_x1 - px0 + total},
        "camera": {"direction": [0.0, -1.0, 0.12],
                   "box": [[-L / 2, -W / 2, 0.0], [L / 2, W / 2, top]]},
    }

    return Component(
        id=f"{params['component']}_{params['size']}", family=params["component"],
        size=str(params["size"]), name=params["display_name"], variant=variant,
        layers=layers, presets=presets, levels={k: round(v, 6) for k, v in levels.items()},
        explode_step_mm=params["explode"]["step_mm"], params=params, physics=physics,
    )
