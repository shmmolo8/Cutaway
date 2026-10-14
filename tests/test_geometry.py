"""Geometry verification for every component parameter file x variant."""
from __future__ import annotations

import json
import struct
from functools import lru_cache
from pathlib import Path

import pytest
from build123d import Compound, GeomType, Vector, import_step

from conftest import component, params
from geometry.build import DEFAULT_TESS, OVERLAP_TOL_MM3, VARIANTS, component_files
from geometry.core.checks import mesh_problems, pairwise_overlaps, solid_problems
from geometry.core.export import export_variant
from geometry.core.layers import Layer, LayerSpec, box
from geometry.core.mesh import tessellate
from geometry.core.params import PROJECT_ROOT

PARAM_FILES = [p.name for p in component_files()]
CASES = [(f, v) for f in PARAM_FILES for v in VARIANTS]
IDS = [f"{f.removesuffix('.yaml')}-{v}" for f, v in CASES]


@lru_cache(maxsize=None)
def reference_bbox(step_path: str):
    return import_step(PROJECT_ROOT / step_path).bounding_box()


def assembly_bbox(comp):
    return Compound([layer.shape for layer in comp.layers]).bounding_box()


@pytest.mark.parametrize("fname,variant", CASES, ids=IDS)
def test_every_solid_valid_and_closed(fname, variant):
    comp = component(fname, variant)
    problems = {l.id: solid_problems(l.shape) for l in comp.layers}
    assert not {k: v for k, v in problems.items() if v}


@pytest.mark.parametrize("fname,variant", CASES, ids=IDS)
def test_no_pairwise_overlap(fname, variant):
    comp = component(fname, variant)
    overlaps = pairwise_overlaps(comp.layers)
    assert overlaps, "expected neighbouring layers to be checked"
    bad = {k: v for k, v in overlaps.items() if v > OVERLAP_TOL_MM3}
    assert not bad


def test_overlap_check_detects_overlap():
    """Negative control: the overlap checker must catch a real overlap."""
    a = Layer(LayerSpec("a", "x", box(0, 1, 0, 1, 0, 1)), box(0, 1, 0, 1, 0, 1))
    b = Layer(LayerSpec("b", "x", box(0.5, 1.5, 0, 1, 0, 1)), box(0.5, 1.5, 0, 1, 0, 1))
    assert pairwise_overlaps([a, b])[("a", "b")] == pytest.approx(0.5)


@pytest.mark.parametrize("fname,variant", CASES, ids=IDS)
def test_bbox_matches_kicad_reference(fname, variant):
    p = params(fname)
    ref = reference_bbox(p["reference_step"])
    bb = assembly_bbox(component(fname, variant))
    tol = p["bbox_tolerance_mm"]
    for got, exp in [(bb.min, ref.min), (bb.max, ref.max)]:
        assert (got - exp).length < tol, f"{got} vs reference {exp}"


@pytest.mark.parametrize("fname,variant", CASES, ids=IDS)
def test_meshes_watertight_outward(fname, variant):
    comp = component(fname, variant)
    tess = {**DEFAULT_TESS, **params(fname).get("tessellation", {})}
    for layer in comp.layers:
        mesh = tessellate(layer.shape, tess["linear_deflection"], tess["angular_deflection"])
        assert not mesh_problems(mesh, layer.shape.volume), layer.id


@pytest.mark.parametrize("fname,variant", CASES, ids=IDS)
def test_thickness_rules(fname, variant):
    """Exaggeration rule for every film; derived bulk layer keeps its minimum share of H."""
    p = params(fname)
    comp = component(fname, variant)
    ex = p["exaggeration"]
    H = p["dimensions"]["height"]
    derived = [l.spec for l in comp.layers if l.spec.derived]
    assert len(derived) == 1
    assert derived[0].thickness_model_um / 1000 >= ex["min_substrate_fraction"] * H
    for spec in (l.spec for l in comp.layers if not l.spec.derived):
        if spec.kind in p.get("no_thickness", []):      # wires etc.: not a film, never scaled
            assert spec.thickness_true_um is None and spec.thickness_model_um is None
            continue
        true = spec.thickness_true_um
        if variant == "true_scale":
            assert spec.thickness_model_um == true
        else:
            expect = max(min(max(true * ex["factor"], ex["min_visible_um"]), ex["max_um"]), true)
            assert spec.thickness_model_um == pytest.approx(expect)


@pytest.mark.parametrize("fname", PARAM_FILES)
def test_export_names_match_metadata(fname, tmp_path: Path):
    p = params(fname)
    comp = component(fname, "exaggerated")
    files = {v: f"models/{comp.id}_{v}" for v in VARIANTS}
    export_variant(comp, tmp_path, files, DEFAULT_TESS, write_step=False)
    meta = json.loads((tmp_path / f"{comp.id}_exaggerated.json").read_text())
    glb = (tmp_path / f"{comp.id}_exaggerated.glb").read_bytes()
    n = struct.unpack("<I", glb[12:16])[0]
    gltf = json.loads(glb[20:20 + n])
    root = gltf["nodes"][gltf["scenes"][0]["nodes"][0]]
    node_names = [gltf["nodes"][i]["name"] for i in root["children"]]

    layer_ids = [l.id for l in comp.layers]
    meta_ids = [l["id"] for l in meta["layers"]]
    assert node_names == layer_ids == meta_ids
    assert len(set(meta_ids)) == len(meta_ids)
    required = {"id", "name", "material", "function", "thickness_true_um", "color",
                "roughness", "metalness", "opacity", "explode"}
    for layer in meta["layers"]:
        assert required <= layer.keys(), layer["id"]
        assert {"direction", "order"} <= layer["explode"].keys()
    # left/right instances that explode along X go outward on their own side
    for layer in meta["layers"]:
        dx = layer["explode"]["direction"][0]
        if layer["id"][-2:] in ("_L", "_R") and dx:
            assert (dx < 0) == layer["id"].endswith("_L"), layer["id"]
    assert {pr["id"] for pr in meta["presets"]} >= {"exterior", "longitudinal", "exploded"}
    assert meta["component"]["category"] and meta["component"]["description"]


@pytest.mark.parametrize("fname,variant", CASES, ids=IDS)
def test_preset_planes_not_coplanar_with_faces(fname, variant):
    """A section plane lying on a B-rep face gives ambiguous caps (and z-fighting)."""
    comp = component(fname, variant)
    for preset in comp.presets:
        if not preset["plane"]:
            continue
        n = Vector(*preset["plane"]["normal"]).normalized()
        p0 = Vector(*preset["plane"]["point"])
        checked = 0
        for layer in comp.layers:
            for face in layer.shape.faces():
                if face.geom_type != GeomType.PLANE:
                    continue
                checked += 1
                if abs(abs(face.normal_at().dot(n)) - 1) < 1e-9:
                    d = abs((face.center() - p0).dot(n))
                    assert d > 1e-4, f"{preset['id']} lies on a face of {layer.id}"
        assert checked > 0
