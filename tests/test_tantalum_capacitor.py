"""Tantalum-capacitor-specific checks."""
import pytest
from build123d import Vector

from conftest import component, params

FILE = "tantalum_capacitor_2012.yaml"


@pytest.mark.parametrize("variant", ["exaggerated", "true_scale"])
def test_cathode_layers_kept_off_the_anode(variant):
    """The anode side (wire, pellet, + frame) never touches the cathode side except through the
    oxide; the washer separates the cathode layers from the wire."""
    comp = component(FILE, variant)
    by_id = {l.id: l.shape for l in comp.layers}
    for a in ("wire", "pellet", "lead_frame_L"):
        for c in ("mno2", "carbon", "silver", "silver_epoxy", "lead_frame_R"):
            assert by_id[a].distance_to(by_id[c]) > 1e-6, (a, c)
    assert by_id["wire"].distance_to(by_id["lead_frame_L"]) < 1e-6          # welded
    assert by_id["silver"].distance_to(by_id["silver_epoxy"]) < 1e-6
    assert by_id["silver_epoxy"].distance_to(by_id["lead_frame_R"]) < 1e-6
    assert by_id["washer"].distance_to(by_id["wire"]) < 1e-6


def test_physics_and_capacitance_plausible():
    comp, p = component(FILE, "exaggerated"), params(FILE)
    ph, e = comp.physics, p["electrical"]
    ids = {l.id for l in comp.layers}
    assert set(ph["contacts"]["positive"]) | set(ph["contacts"]["negative"]) | set(ph["cut_layers"]) <= ids
    d = e["nm_per_volt"] * e["forming_voltage_v"] * 1e-9
    flat = 8.854e-12 * e["epsilon_r"] * ph["electrical"]["ref_area_mm2"] * 1e-6 / d
    assert 100 < e["capacitance_f"] / flat < 1000                   # internal surface of a sintered pellet
    assert ph["oxide_um_true"] * 1000 == pytest.approx(d * 1e9, rel=0.01)
    assert e["forming_voltage_v"] >= 2.5 * e["rated_voltage_v"]      # tantalum is formed well above rating
    assert comp.physics["contacts"]["positive"][0] == "wire" and ph["cut"]["mode"] == "axis"
