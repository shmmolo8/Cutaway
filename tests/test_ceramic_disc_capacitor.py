"""Ceramic-disc-capacitor-specific checks."""
import math

import pytest
from build123d import Vector

from conftest import component, params

FILE = "ceramic_disc_capacitor_d5.yaml"


@pytest.mark.parametrize("variant", ["exaggerated", "true_scale"])
def test_leads_soldered_to_their_electrodes(variant):
    """Each solder joint touches its own electrode and lead, never the other side's."""
    comp = component(FILE, variant)
    by_id = {l.id: l.shape for l in comp.layers}
    for s, o in (("L", "R"), ("R", "L")):
        assert by_id[f"solder_{s}"].distance_to(by_id[f"electrode_{s}"]) < 1e-6
        assert by_id[f"solder_{s}"].distance_to(by_id[f"lead_{s}"]) < 1e-6
        assert by_id[f"solder_{s}"].distance_to(by_id[f"electrode_{o}"]) > 0.1
        assert by_id[f"lead_{s}"].distance_to(by_id["ceramic"]) > 1e-3


@pytest.mark.parametrize("variant", ["exaggerated", "true_scale"])
def test_physics_description_is_consistent(variant):
    comp, p = component(FILE, variant), params(FILE)
    ph, lv = comp.physics, comp.levels
    (x0, z0), (x1, z1) = ph["domain"]
    hi, lo = sorted(ph["plates"], key=lambda q: -q["potential"])
    assert lo["z"][0] == pytest.approx(lv["ceramic_thickness"] / 2) and z1 == pytest.approx(lo["z"][1])
    assert hi["z"][1] == pytest.approx(-lv["ceramic_thickness"] / 2) and z0 == pytest.approx(hi["z"][0])
    assert x1 == pytest.approx(lv["disc_radius"]) and hi["x"][1] == pytest.approx(lv["electrode_radius"])
    ids = {l.id for l in comp.layers}
    assert {"electrode_L", "lead_L"} <= set(ph["contacts"]["positive"]) <= ids
    assert {"electrode_R", "lead_R"} <= set(ph["contacts"]["negative"]) <= ids
    # the section frame's origin lies on the horizontal preset plane
    assert ph["frame"]["origin"][2] == pytest.approx(ph["plane"]["point"][2])
    # eps0 eps_r A / d with the true thickness lands near the marked value
    e = p["electrical"]
    d = ph["electrical"]["real_part"]["dielectric_um"] * 1e-6
    c = 8.854e-12 * e["epsilon_r"] * math.pi * (lv["electrode_radius"] * 1e-3) ** 2 / d
    assert c == pytest.approx(e["capacitance_f"], rel=0.1)
