"""Tessellation of B-rep solids into render meshes (per-face vertices, OCC normals)."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from build123d import Shape
from OCP.BRep import BRep_Tool
from OCP.BRepLib import BRepLib_ToolTriangulatedShape
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.BRepTools import BRepTools
from OCP.TopAbs import TopAbs_FACE, TopAbs_REVERSED
from OCP.TopExp import TopExp_Explorer
from OCP.TopLoc import TopLoc_Location
from OCP.TopoDS import TopoDS


@dataclass
class MeshData:
    positions: np.ndarray   # (N, 3) float32/64
    normals: np.ndarray     # (N, 3)
    indices: np.ndarray     # (M, 3) uint32, CCW = outward


def tessellate(shape: Shape, linear_deflection: float, angular_deflection: float) -> MeshData:
    """Mesh a shape. Vertices are not shared between B-rep faces, so sharp edges stay
    sharp; within a face OCC's analytic surface normals are used (smooth on curves)."""
    BRepTools.Clean_s(shape.wrapped)
    BRepMesh_IncrementalMesh(shape.wrapped, linear_deflection, False, angular_deflection, True)

    positions, normals, indices = [], [], []
    offset = 0
    exp = TopExp_Explorer(shape.wrapped, TopAbs_FACE)
    while exp.More():
        face = TopoDS.Face(exp.Current())
        exp.Next()
        loc = TopLoc_Location()
        tri = BRep_Tool.Triangulation_s(face, loc)
        if tri is None:
            raise RuntimeError("face without triangulation")
        if not tri.HasNormals():
            BRepLib_ToolTriangulatedShape.ComputeNormals_s(face, tri)
        trsf = loc.Transformation()
        n = tri.NbNodes()
        pts = np.array([tri.Node(i).Transformed(trsf).Coord() for i in range(1, n + 1)])
        nrm = np.array([tri.Normal(i).Transformed(trsf).Coord() for i in range(1, n + 1)])
        tris = np.array([tri.Triangle(i).Get() for i in range(1, tri.NbTriangles() + 1)]) - 1
        if face.Orientation() == TopAbs_REVERSED:
            tris = tris[:, [0, 2, 1]]
        # Make normals agree with the (orientation-corrected) winding, whatever
        # convention ComputeNormals used for this face. Vote per triangle: summed normals
        # cancel on closed faces (a full cylinder), so an aggregate test is unreliable.
        t = pts[tris]
        geo = np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0])
        agree = np.einsum("ij,ij->i", geo, nrm[tris].sum(axis=1))
        if np.sum(agree < 0) > np.sum(agree > 0):
            nrm = -nrm
        positions.append(pts)
        normals.append(nrm)
        indices.append(tris + offset)
        offset += n
    return MeshData(
        positions=np.vstack(positions),
        normals=np.vstack(normals),
        indices=np.vstack(indices).astype(np.uint32),
    )
