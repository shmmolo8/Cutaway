"""MLCC-specific checks: interleaved electrodes connect to one end only."""
import pytest

from conftest import component, params

FILE = "mlcc_0603.yaml"


@pytest.mark.parametrize("variant", ["exaggerated", "true_scale"])
def test_electrodes_interleave_and_connect_one_end(variant):
    p, comp = params(FILE), component(FILE, variant)
    by_id = {l.id: l.shape for l in comp.layers}
    n = p["layout"]["electrode_count"]
    plates = {s: by_id[f"inner_electrodes_{s}"].solids() for s in "LR"}
    assert len(plates["L"]) + len(plates["R"]) == n
    assert abs(len(plates["L"]) - len(plates["R"])) <= 1
    for s, other in (("L", "R"), ("R", "L")):
        for plate in plates[s]:
            assert plate.distance_to(by_id[f"copper_{s}"]) < 1e-9          # touches own end
            assert plate.distance_to(by_id[f"copper_{other}"]) > 0.05      # isolated from the other
    # plates alternate L/R going up the stack
    zs = sorted((pl.center().Z, s) for s in "LR" for pl in plates[s])
    assert all(a[1] != b[1] for a, b in zip(zs, zs[1:]))
    # neighbouring L/R plates overlap in plan (that overlap is the capacitor)
    l0, r0 = plates["L"][0].bounding_box(), plates["R"][0].bounding_box()
    assert min(l0.max.X, r0.max.X) - max(l0.min.X, r0.min.X) > 0.5


@pytest.mark.parametrize("variant", ["exaggerated", "true_scale"])
def test_physics_description_is_consistent(variant):
    p, comp = params(FILE), component(FILE, variant)
    ph = comp.physics
    (x0, z0), (x1, z1) = ph["domain"]
    assert len(ph["plates"]) == p["layout"]["electrode_count"]
    for pl in ph["plates"]:
        assert x0 <= pl["x"][0] < pl["x"][1] <= x1 and z0 < pl["z"][0] < pl["z"][1] < z1
        # plates reach their own end face only
        assert (pl["x"][0] == x0) == (pl["potential"] == 1) and (pl["x"][1] == x1) == (pl["potential"] == 0)
    ids = {l.id for l in comp.layers}
    assert set(ph["contacts"]["positive"]) | set(ph["contacts"]["negative"]) <= ids
    assert "inner_electrodes_L" in ph["contacts"]["positive"]
    assert 0 < ph["band_inner_x"] < x1
