"""Chip-resistor-specific checks."""
import pytest
from build123d import Vector

from conftest import component, params

FILE = "chip_resistor_0603.yaml"


@pytest.mark.parametrize("variant", ["exaggerated", "true_scale"])
def test_laser_trim_filled_by_overcoat(variant):
    p, comp = params(FILE), component(FILE, variant)
    by_id = {l.id: l.shape for l in comp.layers}
    t_r = next(l.spec.thickness_model_um for l in comp.layers if l.id == "resistive") / 1000
    x = p["trim"]["plunge_x_fraction"] * comp.levels["gap_half_length"]
    y = -comp.levels["resistive_half_width"] * 0.5        # halfway along the plunge (from -Y)
    z = comp.levels["substrate_top"] + t_r / 2
    assert by_id["overcoat_secondary"].is_inside(Vector(x, y, z))
    assert not by_id["resistive"].is_inside(Vector(x, y, z))
    assert by_id["resistive"].is_inside(Vector(x + 3 * p["trim"]["kerf_width"], y, z))


@pytest.mark.parametrize("variant", ["exaggerated", "true_scale"])
def test_physics_description_is_consistent(variant):
    comp = component(FILE, variant)
    ph = comp.physics
    (x_lo, y_lo), (x_hi, y_hi) = ph["domain"]
    ids = {l.id for l in comp.layers}
    assert x_lo < ph["contact_x"][0] < ph["trim"]["x0"] < ph["trim"]["leg_end_x"] < ph["contact_x"][1] < x_hi
    assert ph["trim"]["leg_end_x"] <= ph["trim"]["leg_end_x_max"] < ph["contact_x"][1]
    assert y_lo < ph["trim"]["y_tip"] < y_hi
    for group in (ph["contacts"]["positive"], ph["contacts"]["negative"], ph["thermal_layers"], ph["fade_layers"]):
        assert set(group) <= ids
    assert "top_electrode_L" in ph["contacts"]["positive"] and "tin_R" in ph["contacts"]["negative"]
    assert ph["surface"]["z_low"] < ph["surface"]["z_high"]
