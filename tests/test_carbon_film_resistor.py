"""Carbon-film-resistor-specific checks."""
import math

import pytest
from build123d import Vector

from conftest import component, params

FILE = "carbon_film_resistor_0204.yaml"


def film_point(comp, turns_in: float, ax_offset: float = 0.0) -> Vector:
    """Point at mid film thickness on the groove centre line `turns_in` turns after its start."""
    ph, lv = comp.physics, comp.levels
    t_f = next(l.spec.thickness_model_um for l in comp.layers if l.id == "carbon_film") / 1000
    a = ph["spiral"]["start_angle"] + 2 * math.pi * turns_in
    r = lv["film_radius"] - t_f / 2
    x = ph["spiral"]["x_start"] + ph["spiral"]["pitch"] * turns_in + ax_offset
    return Vector(x, ph["axis"]["y"] + r * math.cos(a), ph["axis"]["z"] + r * math.sin(a))


@pytest.mark.parametrize("variant", ["exaggerated", "true_scale"])
def test_spiral_groove_filled_by_lacquer(variant):
    comp = component(FILE, variant)
    by_id = {l.id: l.shape for l in comp.layers}
    pitch = comp.physics["spiral"]["pitch"]
    for turns_in in (0.3, 1.5, comp.physics["spiral"]["turns"] - 0.3):
        groove = film_point(comp, turns_in)
        assert by_id["lacquer"].is_inside(groove), turns_in
        assert not by_id["carbon_film"].is_inside(groove), turns_in
        track = film_point(comp, turns_in, pitch / 2)          # half a pitch along: the track
        assert by_id["carbon_film"].is_inside(track), turns_in


@pytest.mark.parametrize("variant", ["exaggerated", "true_scale"])
def test_caps_press_on_the_film(variant):
    """Each cap's inner surface touches the film all around (that is the contact)."""
    comp = component(FILE, variant)
    by_id = {l.id: l.shape for l in comp.layers}
    lv, ph = comp.levels, comp.physics
    ax = (lv["cap_skirt_ax"] + lv["cap_outer_ax"]) / 2 - 0.05
    for side, sg in (("L", -1), ("R", 1)):
        for a in (0.0, 2.0, 4.0):
            for r, layer in ((lv["film_radius"] - 1e-4, "carbon_film"), (lv["film_radius"] + 1e-4, f"cap_{side}")):
                p = Vector(ph["axis"]["x_center"] + sg * ax, r * math.cos(a), ph["axis"]["z"] + r * math.sin(a))
                assert by_id[layer].is_inside(p), (side, a, layer)


@pytest.mark.parametrize("variant", ["exaggerated", "true_scale"])
def test_physics_description_is_consistent(variant):
    comp = component(FILE, variant)
    ph, p = comp.physics, params(FILE)
    (x_lo, s_lo), (x_hi, s_hi) = ph["domain"]
    sp = ph["spiral"]
    ids = {l.id for l in comp.layers}
    assert x_lo < ph["contact_x"][0] < sp["x_start"] < sp["x_limit"] < ph["contact_x"][1] < x_hi
    assert sp["x_start"] + sp["turns"] * sp["pitch"] + sp["kerf"] / 2 <= sp["x_limit"] + 1e-9
    assert s_lo == 0 and s_hi == pytest.approx(2 * math.pi * ph["radius"])
    assert ph["radius"] == pytest.approx(comp.levels["film_radius"])
    for group in (ph["contacts"]["positive"], ph["contacts"]["negative"], ph["thermal_layers"],
                  ph["fade_layers"], ph["hide_layers"]):
        assert set(group) <= ids
    assert {"cap_L", "lead_L"} <= set(ph["contacts"]["positive"])
    assert {"cap_R", "lead_R"} <= set(ph["contacts"]["negative"])
    # the physics uses the true film thickness in both variants
    assert ph["film"]["thickness_um"] == p["thickness_um"]["carbon_film"]
    # rough squares count of the modelled cut: rho/t * squares lands near the nominal value
    circ = 2 * math.pi * ph["radius"]
    turn = math.hypot(circ, sp["pitch"])
    squares = (sp["turns"] - 1) * turn / ((sp["pitch"] - sp["kerf"]) * circ / turn)
    r_est = p["electrical"]["resistivity_ohm_m"] / (ph["film"]["thickness_um"] * 1e-6) * squares
    assert r_est == pytest.approx(p["electrical"]["nominal_ohm"], rel=0.15)
