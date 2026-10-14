"""B-rep and mesh validation shared by every component."""
from __future__ import annotations

from itertools import combinations

import numpy as np
import trimesh
from build123d import Shape
from OCP.BRep import BRep_Tool
from OCP.BRepCheck import BRepCheck_Analyzer

from .layers import Layer
from .mesh import MeshData


def solid_problems(shape: Shape) -> list[str]:
    """Empty list if every solid in `shape` is valid, closed and has positive volume."""
    problems = []
    if not BRepCheck_Analyzer(shape.wrapped).IsValid():
        problems.append("BRepCheck_Analyzer: invalid")
    for i, solid in enumerate(shape.solids()):
        shells = solid.shells()
        if not shells:
            problems.append(f"solid {i}: no shell")
        for j, shell in enumerate(shells):
            if not BRep_Tool.IsClosed_s(shell.wrapped):
                problems.append(f"solid {i} shell {j}: open")
        if solid.volume <= 0:
            problems.append(f"solid {i}: non-positive volume {solid.volume}")
    return problems


def _bbox_overlap(a: Shape, b: Shape, eps: float = 1e-9) -> bool:
    ba, bb = a.bounding_box(), b.bounding_box()
    return (ba.min.X < bb.max.X - eps and bb.min.X < ba.max.X - eps and
            ba.min.Y < bb.max.Y - eps and bb.min.Y < ba.max.Y - eps and
            ba.min.Z < bb.max.Z - eps and bb.min.Z < ba.max.Z - eps)


def pairwise_overlaps(layers: list[Layer]) -> dict[tuple[str, str], float]:
    """Intersection volume (mm^3) for every pair of layers whose boxes overlap."""
    out = {}
    for a, b in combinations(layers, 2):
        if not _bbox_overlap(a.shape, b.shape):
            continue
        common = a.shape.intersect(b.shape)
        # intersect() may return None, a Shape or a ShapeList; only solids have volume
        parts = [] if common is None else (list(common) if isinstance(common, list) else [common])
        out[(a.id, b.id)] = sum(abs(s.volume) for p in parts for s in p.solids())
    return out


def mesh_problems(mesh: MeshData, brep_volume: float, rel_tol: float = 1e-3) -> list[str]:
    """Check a tessellation is watertight, consistently wound and outward-facing."""
    problems = []
    tm = trimesh.Trimesh(mesh.positions, mesh.indices, process=False)
    tm.merge_vertices(merge_tex=True, merge_norm=True, digits_vertex=7)
    if not tm.is_watertight:
        problems.append("mesh not watertight")
    if not tm.is_winding_consistent:
        problems.append("mesh winding inconsistent")
    vol = tm.volume
    if vol <= 0:
        problems.append(f"mesh volume {vol:.3e} <= 0 (inward normals)")
    elif abs(vol - brep_volume) > rel_tol * brep_volume:
        problems.append(f"mesh volume {vol:.6e} != brep volume {brep_volume:.6e}")
    # vertex normals must agree with face winding
    tri = mesh.positions[mesh.indices]
    fn = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    vn = mesh.normals[mesh.indices].sum(axis=1)
    if np.any(np.einsum("ij,ij->i", fn, vn) < 0):
        problems.append("vertex normals disagree with triangle winding")
    return problems
