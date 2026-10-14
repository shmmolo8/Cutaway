"""Parameter-file loading: YAML with single-parent `extends:` inheritance."""
from __future__ import annotations

import copy
from pathlib import Path

import yaml

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = PROJECT_ROOT / "data"


def deep_merge(base: dict, override: dict) -> dict:
    """Return base updated recursively with override (override wins)."""
    out = copy.deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = deep_merge(out[key], value)
        else:
            out[key] = copy.deepcopy(value)
    return out


def load_params(path: str | Path) -> dict:
    """Load a component parameter file, resolving `extends:` relative to it."""
    path = Path(path).resolve()
    with path.open() as fh:
        data = yaml.safe_load(fh) or {}
    parent = data.pop("extends", None)
    if parent:
        data = deep_merge(load_params(path.parent / parent), data)
    data.setdefault("_source", str(path.relative_to(PROJECT_ROOT)))
    return data


def load_materials(path: str | Path = DATA_DIR / "materials.yaml") -> dict:
    with Path(path).open() as fh:
        return yaml.safe_load(fh)
