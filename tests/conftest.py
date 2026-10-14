"""Shared, cached component builds for all test modules."""
from functools import lru_cache

from geometry.build import build_component
from geometry.core.params import DATA_DIR, load_params


@lru_cache(maxsize=None)
def params(fname: str) -> dict:
    return load_params(DATA_DIR / fname)


@lru_cache(maxsize=None)
def component(fname: str, variant: str):
    return build_component(params(fname), variant)
