"""Shielded-axial-inductor-specific checks."""
import pytest

from conftest import component, params

FILE = "axial_inductor_l11.yaml"


@pytest.mark.parametrize("variant", ["exaggerated", "true_scale"])
def test_current_path_and_shield_gap(variant):
    """lead - cap - lead-out - winding on each side; the sleeve sits a gap above the flanges
    (an epoxy-filled gap that sets L) and never touches the winding or the caps."""
    comp, p = component(FILE, variant), params(FILE)
    by_id = {l.id: l.shape for l in comp.layers}
    touch = lambda a, b: by_id[a].distance_to(by_id[b]) < 1e-6
    for s in ("L", "R"):
        assert touch(f"lead_{s}", f"cap_{s}") and touch(f"cap_{s}", f"leadout_{s}") and touch(f"leadout_{s}", "winding")
    gap = p["dimensions"]["sleeve"]["gap"]
    assert by_id["sleeve"].distance_to(by_id["drum"]) == pytest.approx(gap, abs=1e-6)
    for other in ("winding", "cap_L", "cap_R"):
        assert by_id["sleeve"].distance_to(by_id[other]) > gap / 2


def test_physics_description():
    comp = component(FILE, "exaggerated")
    ph = comp.physics
    shield = [f for f in ph["ferrite"] if f.get("group") == "shield"]
    assert len(shield) == 2 and ph["shield_layer"] == "sleeve"
    assert {c["dir"] for c in ph["cuts"]} == {1, -1} and all(c["amps"] == ph["turns"] for c in ph["cuts"])
    (x0, z0), (x1, z1) = ph["domain"]
    assert z0 < ph["axisym"]["axis_z"] < z1 and x0 < ph["probe"]["window"][0] < x1
