"""2D section previews (matplotlib) of a component's preset planes.

    python -m geometry.preview data/chip_resistor_0603.yaml [--out .test-output/preview]

Slices the tessellated layer meshes (what the viewer receives) with the preset
planes from the component and draws each layer's section filled in its colour.
Used for milestone-1 sanity checks, independent of the WebGL viewer.
"""
from __future__ import annotations

import argparse
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import trimesh  # noqa: E402
from matplotlib.patches import Patch, PathPatch  # noqa: E402
from matplotlib.path import Path as MplPath  # noqa: E402

from .build import DEFAULT_TESS, VARIANTS, build_component, component_files  # noqa: E402
from .core.export import mesh_component  # noqa: E402
from .core.params import PROJECT_ROOT, load_materials, load_params  # noqa: E402

def plane_axes(normal):
    """In-plane (u, v) axes and labels for an axis-aligned plane normal."""
    k = int(np.argmax(np.abs(normal)))
    return {0: ((0, 1, 0), (0, 0, 1), "Y (mm)", "Z (mm)"),
            1: ((1, 0, 0), (0, 0, 1), "X (mm)", "Z (mm)"),
            2: ((1, 0, 0), (0, 1, 0), "X (mm)", "Y (mm)")}[k]


def section_polys(mesh: trimesh.Trimesh, origin, normal, u, v):
    sec = mesh.section(plane_origin=origin, plane_normal=normal)
    if sec is None:
        return []
    T = np.eye(4)
    T[:3, :3] = np.array([u, v, np.cross(u, v)])
    # keep absolute in-plane coordinates; only drop the offset along the normal
    T[2, 3] = -T[2, :3] @ np.asarray(origin, float)
    planar, _ = sec.to_2D(to_2D=T, check=False)
    return planar.polygons_full


def draw(ax, comp, meshes, colors, preset, window=None, title=None):
    plane = preset["plane"]
    u, v, xl, yl = plane_axes(plane["normal"])
    for layer in comp.layers:
        m = meshes[layer.id]
        tm = trimesh.Trimesh(m.positions, m.indices, process=False)
        tm.merge_vertices(digits_vertex=7)
        for poly in section_polys(tm, plane["point"], plane["normal"], u, v):
            rings = [np.asarray(poly.exterior.coords)] + [np.asarray(r.coords) for r in poly.interiors]
            verts = np.vstack(rings)
            codes = np.concatenate([[MplPath.MOVETO] + [MplPath.LINETO] * (len(r) - 2) + [MplPath.CLOSEPOLY]
                                    for r in rings])
            ax.add_patch(PathPatch(MplPath(verts, codes), facecolor=colors[layer.spec.kind],
                                   edgecolor="#00000055", linewidth=0.3))
    if window:
        ax.set_xlim(*window[0]); ax.set_ylim(*window[1])
    else:
        # frame the whole part (any origin convention), padded by 5 %
        pts = np.vstack([m.positions for m in meshes.values()])
        lo, hi = pts.min(axis=0), pts.max(axis=0)
        for axis_dir, setter in ((u, ax.set_xlim), (v, ax.set_ylim)):
            k = int(np.argmax(np.abs(axis_dir)))
            pad = 0.05 * (hi[k] - lo[k])
            setter(lo[k] - pad, hi[k] + pad)
    ax.set_aspect("equal")
    ax.set_xlabel(xl, fontsize=7); ax.set_ylabel(yl, fontsize=7)
    ax.tick_params(labelsize=6)
    ax.set_title(title or preset["label"], fontsize=8)
    ax.set_facecolor("#f4f5f7")


def render(params_path: Path, out_dir: Path) -> list[Path]:
    params = load_params(params_path)
    materials = load_materials()
    colors = {k: materials[d["material"]]["color"] for k, d in params["layers"].items()}
    out_dir.mkdir(parents=True, exist_ok=True)
    written = []
    for variant in VARIANTS:
        comp = build_component(params, variant)
        meshes = mesh_component(comp, {**DEFAULT_TESS, **params.get("tessellation", {})})
        planes = [p for p in comp.presets if p["plane"]]
        cols = 2
        rows = (len(planes) + cols - 1) // cols
        fig, axes = plt.subplots(rows, cols, figsize=(12, 3.8 * rows), dpi=150, squeeze=False)
        for ax, preset in zip(axes.flat, planes):
            draw(ax, comp, meshes, colors, preset)
        for ax in list(axes.flat)[len(planes):]:
            ax.axis("off")
        handles = [Patch(facecolor=colors[k], edgecolor="#0006", label=params["layers"][k]["name"])
                   for k in dict.fromkeys(l.spec.kind for l in comp.layers)]
        fig.legend(handles=handles, loc="lower center", ncol=5, fontsize=8, frameon=False)
        fig.suptitle(f"{comp.name} - {variant}", fontsize=11)
        fig.tight_layout(rect=(0, 0.05, 1, 0.97))
        path = out_dir / f"{comp.id}_{variant}_sections.png"
        fig.savefig(path)
        plt.close(fig)
        written.append(path)
    return written


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("params", nargs="*", type=Path)
    ap.add_argument("--out", type=Path, default=PROJECT_ROOT / ".test-output" / "preview")
    args = ap.parse_args()
    for p in args.params or component_files():
        for path in render(p, args.out):
            print(path)


if __name__ == "__main__":
    main()
