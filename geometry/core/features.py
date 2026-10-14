"""Reusable construction features shared by component generators."""
from __future__ import annotations

from collections.abc import Callable

from .layers import LayerSpec, box

SIDES = (("L", -1.0), ("R", 1.0))


def five_sided_caps(spec: Callable[..., LayerSpec], *, length: float, band: float,
                    body_hx: float, body_hw: float, body_z: tuple[float, float],
                    films: list[tuple[str, float]]) -> list[LayerSpec]:
    """Nested end caps (e.g. Cu/Ni/Sn) wrapping end face, top, bottom and both sides.

    `films` lists (kind, thickness) inside-out; their total must equal the gap between the
    body and the outer box. Each film also covers the inner rim of the one below it, and
    the outermost band ends exactly `band` from the outer end. `spec(id, kind, envelope,
    sign=..., group=...)` builds the LayerSpec. Returns specs in placement order.
    """
    z0, z1 = body_z
    total = sum(t for _, t in films)
    x_in = length / 2 - band + total - films[0][1]      # inner edge of the base film
    specs, grow = [], 0.0
    for k, (kind, t) in enumerate(films):
        grow += t
        if k:
            x_in -= t
        for s, sg in SIDES:
            env = box(sg * x_in, sg * (body_hx + grow), -(body_hw + grow), body_hw + grow,
                      z0 - grow, z1 + grow)
            specs.append(spec(f"{kind}_{s}", kind, env, sign=sg, group=f"end_{s}"))
    return specs


def rect_point(s: float, cx: float, cy: float) -> tuple[float, float]:
    """Point at arc length s along a rectangle centred on the origin (half sizes cx, cy),
    starting at (-cx, -cy) and running counter-clockwise."""
    P = 4 * (cx + cy)
    s %= P
    if s < 2 * cx:
        return -cx + s, -cy
    s -= 2 * cx
    if s < 2 * cy:
        return cx, -cy + s
    s -= 2 * cy
    if s < 2 * cx:
        return cx - s, cy
    return -cx, cy - (s - 2 * cx)


def rect_arc_boxes(cx: float, cy: float, s0: float, length: float, width: float,
                   z0: float, z1: float) -> list:
    """Boxes of a `width`-wide trace following the rectangle from s0 for `length`
    (square corners: each straight piece is extended by width/2)."""
    corners = [0, 2 * cx, 2 * cx + 2 * cy, 4 * cx + 2 * cy, 4 * (cx + cy)]
    P = corners[-1]
    boxes, s, end = [], s0, s0 + length
    while end - s > 1e-12:
        base = (s // P) * P
        if s - base > P - 1e-9:                 # within rounding of a full lap: next lap
            base += P
        nxt = base + next(c for c in corners[1:] if c > s - base + 1e-12)
        e = min(end, nxt)
        (ax, ay), (bx, by) = rect_point(s, cx, cy), rect_point(e - 1e-12, cx, cy)
        h = width / 2
        boxes.append(box(min(ax, bx) - h, max(ax, bx) + h, min(ay, by) - h, max(ay, by) + h, z0, z1))
        s = e
    return boxes
