"""Inductor-specific checks: one continuous coil joining the two terminations."""
import build123d as bd
import pytest
from build123d import Vector

from conftest import component, params

FILE = "inductor_0603.yaml"


@pytest.mark.parametrize("variant", ["exaggerated", "true_scale"])
def test_coil_is_one_conductor_between_terminations(variant):
    comp = component(FILE, variant)
    by_id = {l.id: l.shape for l in comp.layers}
    coil = by_id["coil"]
    assert len(coil.solids()) == 1
    assert len(by_id["ferrite"].solids()) == 1
    for s in "LR":
        assert coil.distance_to(by_id[f"silver_termination_{s}"]) < 1e-9
        assert coil.distance_to(by_id[f"nickel_{s}"]) > 1e-3


@pytest.mark.parametrize("variant", ["exaggerated", "true_scale"])
def test_every_sheet_carries_coil_and_vias_join_them(variant):
    p, comp = params(FILE), component(FILE, variant)
    coil = next(l.shape for l in comp.layers if l.id == "coil")
    lv, n = comp.levels, p["coil"]["layers"]
    pitch, cy = lv["coil_pitch"], lv["coil_half_width"]
    for i in range(n):
        z = lv["coil_bottom"] + (i + 0.5) * pitch
        # the trace runs mid-way along the +Y or -Y side on every sheet (3/4 turn each)
        assert coil.is_inside(Vector(0, cy, z)) or coil.is_inside(Vector(0, -cy, z)), f"sheet {i}"
    # between sheets only the vias are metal: a slice between sheets has n-1 via crossings
    mid = lv["coil_bottom"] + pitch                  # between sheet 0 and 1
    cut = coil.intersect(bd.Pos(0, 0, mid) * bd.Box(4, 4, 1e-4))
    assert cut is not None and len(cut.solids()) == 1, "exactly one via between adjacent sheets"


@pytest.mark.parametrize("variant", ["exaggerated", "true_scale"])
def test_physics_description_is_consistent(variant):
    comp = component(FILE, variant)
    ph = comp.physics
    (bx0, bz0), (bx1, bz1) = ph["body"]
    assert ph["domain"][0][0] < bx0 and ph["domain"][1][0] > bx1
    # cuts lie inside the body; both sides present with opposite current directions
    assert {c["dir"] for c in ph["cuts"]} == {1.0, -1.0}
    for c in ph["cuts"]:
        assert bx0 < c["x"][0] < c["x"][1] < bx1 and bz0 < c["z"][0] < c["z"][1] < bz1
    # 4.5 turns -> each side is crossed ~4-5 times in the section
    counts = [sum(1 for c in ph["cuts"] if c["dir"] == s) for s in (1.0, -1.0)]
    assert all(4 <= k <= 5 for k in counts), counts
    # the conductor path runs from one end face to the other and every point is inside the body
    path = ph["coil_path"]
    assert path[0][0] == pytest.approx(bx0) and path[-1][0] == pytest.approx(bx1)
    assert all(bz0 < p[2] < bz1 for p in path)
