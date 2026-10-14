"""Generic layer model and the no-overlap carving pipeline.

Every physical layer is described by an *envelope* (the volume it would occupy
if nothing else existed). Layers are placed in priority order (inside-out); each
placed solid is `envelope - union(already placed solids)`. Neighbours therefore
only ever share faces, which is what the viewer's stencil capping requires.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from build123d import Location, Shape, Solid


# --------------------------------------------------------------------------- primitives
def box(x0: float, x1: float, y0: float, y1: float, z0: float, z1: float) -> Solid:
    """Axis-aligned box from two corners (order of each pair doesn't matter)."""
    xa, xb = sorted((x0, x1))
    ya, yb = sorted((y0, y1))
    za, zb = sorted((z0, z1))
    if min(xb - xa, yb - ya, zb - za) <= 0:
        raise ValueError(f"degenerate box {(x0, x1, y0, y1, z0, z1)}")
    return Solid.make_box(xb - xa, yb - ya, zb - za).moved(Location((xa, ya, za)))


def union(*shapes: Shape) -> Shape:
    """Fuse shapes into one (cleaned) shape."""
    first, *rest = shapes
    return first.fuse(*rest).clean() if rest else first


# --------------------------------------------------------------------------- thickness
def model_thickness_um(true_um: float, variant: str, ex: dict) -> float:
    """Thickness used for geometry in a given variant.

    exaggerated: max(true * factor, min_visible), capped at max_um, never below true.
    """
    if variant == "true_scale":
        return float(true_um)
    if variant != "exaggerated":
        raise ValueError(f"unknown variant {variant!r}")
    value = max(true_um * ex["factor"], ex["min_visible_um"])
    value = min(value, ex.get("max_um", value))
    return float(max(value, true_um))


# --------------------------------------------------------------------------- layers
@dataclass
class LayerSpec:
    """A layer before carving."""

    id: str
    kind: str                      # key into the component's `layers:` descriptions
    envelope: Shape
    cuts: list[Shape] = field(default_factory=list)   # extra subtractions (e.g. laser trim)
    explode_direction: tuple[float, float, float] = (0.0, 0.0, 0.0)
    explode_order: int = 0
    group: str | None = None
    thickness_true_um: float | None = None
    thickness_model_um: float | None = None
    allow_multiple_solids: bool = False
    derived: bool = False          # bulk layer whose thickness is whatever the others leave


@dataclass
class Layer:
    """A carved, final layer."""

    spec: LayerSpec
    shape: Shape

    @property
    def id(self) -> str:
        return self.spec.id


def carve(specs: list[LayerSpec]) -> list[Layer]:
    """Place layers in order; each is its envelope minus everything placed before it."""
    placed: list[Layer] = []
    for spec in specs:
        shape: Shape = spec.envelope
        tools = [*spec.cuts, *(p.shape for p in placed)]
        if tools:
            shape = shape.cut(*tools)
        shape = shape.clean()
        solids = shape.solids()
        if not solids:
            raise ValueError(f"layer {spec.id!r} is empty after carving")
        if len(solids) > 1 and not spec.allow_multiple_solids:
            vols = [round(s.volume, 9) for s in solids]
            raise ValueError(f"layer {spec.id!r} split into {len(solids)} solids: {vols}")
        if len(solids) == 1:
            shape = solids[0]
        placed.append(Layer(spec, shape))
    return placed


@dataclass
class Component:
    """Output of a component generator: carved layers plus viewer hints."""

    id: str                        # e.g. chip_resistor_0603
    family: str                    # e.g. chip_resistor
    size: str
    name: str
    variant: str
    layers: list[Layer]
    presets: list[dict]
    levels: dict[str, float]       # named Z levels / X stations for reference (mm)
    explode_step_mm: float
    params: dict
    physics: dict | None = None    # optional viewer physics description (see CLAUDE.md)


# --------------------------------------------------------------------------- section planes
def face_levels(layers: list[Layer], normal) -> list[float]:
    """Signed offsets (along `normal`) of every planar face parallel to it."""
    from build123d import GeomType, Vector

    n = Vector(*normal).normalized()
    levels = set()
    for layer in layers:
        for face in layer.shape.faces():
            if face.geom_type == GeomType.PLANE and abs(abs(face.normal_at().dot(n)) - 1) < 1e-9:
                levels.add(round(face.center().dot(n), 9))
    return sorted(levels)


def clear_plane(layers: list[Layer], plane: dict, min_gap: float = 1e-4) -> dict:
    """Return `plane` moved (along its normal) off any coincident B-rep face.

    A section plane lying exactly on a face makes the cut ambiguous (and z-fights
    in the viewer). If the plane is within `min_gap` of a face level, it is moved
    to the midpoint between that level and the next level beyond it.
    """
    from build123d import Vector

    n = Vector(*plane["normal"]).normalized()
    p = Vector(*plane["point"])
    d = p.dot(n)
    levels = face_levels(layers, plane["normal"])
    hits = [lv for lv in levels if abs(lv - d) < min_gap]
    if not hits:
        return plane
    above = [lv for lv in levels if lv > hits[-1] + min_gap]
    below = [lv for lv in levels if lv < hits[0] - min_gap]
    target = (hits[-1] + above[0]) / 2 if above else (hits[0] + below[-1]) / 2
    q = p + n * (target - d)
    return {**plane, "point": [round(q.X, 9), round(q.Y, 9), round(q.Z, 9)]}
