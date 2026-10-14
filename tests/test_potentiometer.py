"""Trimmer-potentiometer-specific checks."""
import pytest

from conftest import component

FILE = "potentiometer_3266w.yaml"


@pytest.mark.parametrize("variant", ["exaggerated", "true_scale"])
def test_conduction_path(variant):
    """pin 1 - termination R - track - termination L - pin 3; wiper bridges collector and track;
    collector - pin 2; the wiper side never touches an end termination or its pin."""
    comp = component(FILE, variant)
    by_id = {l.id: l.shape for l in comp.layers}
    touch = lambda a, b: by_id[a].distance_to(by_id[b]) < 1e-6
    assert touch("lead_R", "termination_R") and touch("termination_R", "track")
    assert touch("track", "termination_L") and touch("termination_L", "lead_L")
    assert touch("wiper", "track") and touch("wiper", "collector") and touch("collector", "lead_wiper")
    for a in ("collector", "lead_wiper"):
        for b in ("termination_L", "termination_R", "lead_L", "lead_R", "track"):
            assert not touch(a, b), (a, b)
    assert not touch("rotor", "screw")                      # worm and wheel run with clearance


def test_wiper_built_at_the_middle():
    comp = component(FILE, "exaggerated")
    ph = comp.physics
    t = ph["track"]
    assert comp.levels["wiper_deg"] == pytest.approx(t["to_deg"] - (t["to_deg"] - t["from_deg"]) * ph["turns"]["built"] / ph["turns"]["total"])
    rot = {tuple(r["ids"]): r for r in ph["rotate"]}
    assert rot[("rotor", "wiper")]["deg_per_turn"] * ph["turns"]["total"] == pytest.approx(-(t["to_deg"] - t["from_deg"]))
