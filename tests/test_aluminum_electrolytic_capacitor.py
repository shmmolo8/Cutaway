"""Aluminium-electrolytic-specific checks."""
import math

import pytest
from build123d import Vector

from conftest import component, params

FILE = "aluminum_electrolytic_capacitor_d8.yaml"


@pytest.mark.parametrize("variant", ["exaggerated", "true_scale"])
def test_winding_order_and_tabs(variant):
    """Going outward along -x: anode (with oxide on both faces), paper, cathode, paper ...;
    each tab touches its own foil only."""
    comp, p = component(FILE, variant), params(FILE)
    by_id = {l.id: l.shape for l in comp.layers}
    lv, pitch = comp.levels, p["winding"]["pitch"]
    zm = (lv["foil_z0"] + lv["foil_z1"]) / 2
    x_a = 0.0                                    # the anode passes over pin 1 (built so in the generator)
    assert by_id["anode_foil"].is_inside(Vector(x_a, 0, zm))
    t_a = p["thickness_um"]["anode_foil"] / 1000
    t_ox = next(l.spec.thickness_model_um for l in comp.layers if l.id == "oxide") / 1000
    for sg in (-1, 1):                                               # oxide just outside each face
        assert by_id["oxide"].is_inside(Vector(x_a + sg * (t_a / 2 + t_ox / 2), 0, zm))
    assert by_id["separator"].is_inside(Vector(x_a - pitch / 4, 0, zm))    # half way to the cathode
    assert by_id["cathode_foil"].is_inside(Vector(x_a - pitch / 2, 0, zm))
    for s, foil, other in (("L", "anode_foil", "cathode_foil"), ("R", "cathode_foil", "anode_foil")):
        assert by_id[f"tab_{s}"].distance_to(by_id[foil]) < 1e-6
        assert by_id[f"tab_{s}"].distance_to(by_id[other]) > 0.02
        assert by_id[f"tab_{s}"].distance_to(by_id[f"lead_{s}"]) < 1e-6


def test_vent_scored_and_capacitance_plausible():
    comp, p = component(FILE, "exaggerated"), params(FILE)
    can = {l.id: l.shape for l in comp.layers}["can"]
    lv = comp.levels
    assert not can.is_inside(Vector(lv["axis_x"] + 1.0, 0, lv["can_top"] - 0.05))     # in the score
    assert can.is_inside(Vector(lv["axis_x"] + 1.0, 1.0, lv["can_top"] - 0.05))
    e = p["electrical"]
    d = e["nm_per_volt"] * e["forming_voltage_v"] * 1e-9
    flat = 8.854e-12 * e["epsilon_r"] * 2 * e["anode_length_mm"] * e["foil_width_mm"] * 1e-6 / d
    assert 20 < e["capacitance_f"] / flat < 100                      # implied etch gain is typical
    assert e["foil_width_mm"] == pytest.approx(lv["foil_z1"] - lv["foil_z0"])
    assert comp.physics["oxide_um_true"] * 1000 == pytest.approx(d * 1e9, rel=0.01)
