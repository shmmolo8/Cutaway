"""Generate, validate and export components.

    python -m geometry.build data/chip_resistor_0603.yaml [more.yaml ...] [--out build]

For each parameter file and each variant: build solids -> validate (B-rep validity,
closedness, pairwise overlap, mesh watertightness) -> write GLB + JSON (+ STEP).
Also (re)writes build/index.json listing everything in the build directory.
"""
from __future__ import annotations

import argparse
import importlib
import json
import sys
import time
from pathlib import Path

from .core.checks import mesh_problems, pairwise_overlaps, solid_problems
from .core.export import export_variant
from .core.layers import Component
from .core.params import DATA_DIR, PROJECT_ROOT, load_params

VARIANTS = ("exaggerated", "true_scale")
DEFAULT_TESS = {"linear_deflection": 0.0005, "angular_deflection": 0.1}
OVERLAP_TOL_MM3 = 1e-9
MODELS_DIR = "models"          # build/models/<component id>_<variant>.{glb,json,step}


def build_component(params: dict, variant: str) -> Component:
    module = importlib.import_module(params["generator"])
    return module.build(params, variant)


def validate(comp: Component) -> list[str]:
    errors = []
    for layer in comp.layers:
        errors += [f"{layer.id}: {p}" for p in solid_problems(layer.shape)]
    for (a, b), vol in pairwise_overlaps(comp.layers).items():
        if vol > OVERLAP_TOL_MM3:
            errors.append(f"overlap {a} x {b}: {vol:.3e} mm^3")
    return errors


def component_files() -> list[Path]:
    """Every component parameter file in data/ (materials.yaml is not one)."""
    return sorted(p for p in DATA_DIR.glob("*.yaml") if "generator:" in p.read_text())


def write_index(out_root: Path) -> None:
    entries = []
    for meta_path in sorted((out_root / MODELS_DIR).glob("*_exaggerated.json")):
        meta = json.loads(meta_path.read_text())["component"]
        entries.append({"id": meta["id"], "name": meta["name"], "family": meta["family"],
                        "category": meta["category"], "description": meta["description"],
                        "size": meta["size"], "variants": meta["variants"],
                        "default_variant": "exaggerated"})
    (out_root / "index.json").write_text(json.dumps({"components": entries}, indent=2))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("params", nargs="*", type=Path,
                    help="parameter files (default: every component YAML in data/)")
    ap.add_argument("--out", type=Path, default=PROJECT_ROOT / "build")
    ap.add_argument("--no-step", action="store_true", help="skip STEP export")
    args = ap.parse_args(argv)

    failed = False
    for path in args.params or component_files():
        params = load_params(path)
        tess = {**DEFAULT_TESS, **params.get("tessellation", {})}
        out_dir = args.out / MODELS_DIR
        cid = f"{params['component']}_{params['size']}"
        variant_files = {v: f"{MODELS_DIR}/{cid}_{v}" for v in VARIANTS}
        for variant in VARIANTS:
            t0 = time.time()
            comp = build_component(params, variant)
            errors = validate(comp)
            meshes = export_variant(comp, out_dir, variant_files, tess, write_step=not args.no_step)
            for layer in comp.layers:
                errors += [f"{layer.id}: {p}" for p in
                           mesh_problems(meshes[layer.id], layer.shape.volume)]
            status = "OK" if not errors else "FAIL"
            ntri = sum(len(m.indices) for m in meshes.values())
            print(f"[{status}] {comp.id} {variant}: {len(comp.layers)} layers, {ntri} tris, "
                  f"{time.time() - t0:.1f}s")
            for e in errors:
                print(f"    {e}")
            failed |= bool(errors)
    write_index(args.out)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
