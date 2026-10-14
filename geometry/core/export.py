"""GLB + metadata export (component-agnostic)."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import trimesh
from build123d import Compound, export_step

from .layers import Component
from .mesh import MeshData, tessellate
from .params import load_materials

SCHEMA_VERSION = 1
# CAD (Z-up) -> glTF (Y-up): rotate -90 deg about X. Applied on the root node only,
# so layer nodes (and metadata vectors) stay in the CAD frame.
Z_UP_TO_Y_UP = trimesh.transformations.rotation_matrix(-np.pi / 2, [1, 0, 0])


def _hex_to_rgba(hex_color: str, opacity: float) -> list[float]:
    h = hex_color.lstrip("#")
    return [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)] + [opacity]


def mesh_component(comp: Component, tess: dict) -> dict[str, MeshData]:
    return {
        layer.id: tessellate(layer.shape, tess["linear_deflection"], tess["angular_deflection"])
        for layer in comp.layers
    }


def write_glb(comp: Component, meshes: dict[str, MeshData], materials: dict, path: Path) -> None:
    scene = trimesh.Scene(base_frame="world")
    root = comp.id
    scene.graph.update(frame_from="world", frame_to=root, matrix=Z_UP_TO_Y_UP)
    for layer in comp.layers:
        m = meshes[layer.id]
        mat = materials[comp.params["layers"][layer.spec.kind]["material"]]
        pbr = trimesh.visual.material.PBRMaterial(
            name=layer.id,
            baseColorFactor=_hex_to_rgba(mat["color"], mat["opacity"]),
            metallicFactor=mat["metalness"],
            roughnessFactor=mat["roughness"],
            alphaMode="BLEND" if mat["opacity"] < 1 else "OPAQUE",
            doubleSided=False,
        )
        tm = trimesh.Trimesh(m.positions, m.indices, vertex_normals=m.normals, process=False,
                             visual=trimesh.visual.TextureVisuals(material=pbr))
        scene.add_geometry(tm, node_name=layer.id, geom_name=layer.id, parent_node_name=root)
    path.write_bytes(scene.export(file_type="glb", include_normals=True))


def build_metadata(comp: Component, materials: dict, variant_files: dict[str, str]) -> dict:
    bb = Compound([l.shape for l in comp.layers]).bounding_box()
    layers = []
    for layer in comp.layers:
        s = layer.spec
        d = comp.params["layers"][s.kind]
        mat = materials[d["material"]]
        layers.append({
            "id": s.id,
            "kind": s.kind,
            "name": d["name"] + (f" ({s.id[-1]})" if s.id[-2:] in ("_L", "_R") else ""),
            "material": mat["name"],
            "function": " ".join(d["function"].split()),
            "thickness_true_um": s.thickness_true_um,
            "thickness_model_um": s.thickness_model_um,
            "derived": s.derived,
            "color": mat["color"],
            "roughness": mat["roughness"],
            "metalness": mat["metalness"],
            "opacity": mat["opacity"],
            "group": s.group,
            "volume_mm3": round(layer.shape.volume, 9),
            "explode": {"direction": list(s.explode_direction), "order": s.explode_order},
        })
    return {
        "schema_version": SCHEMA_VERSION,
        "component": {
            "id": comp.id,
            "family": comp.family,
            "size": comp.size,
            "name": comp.name,
            "category": comp.params.get("category", comp.family),
            "description": comp.params.get("description", ""),
            "variant": comp.variant,
            "variants": variant_files,
            "units": "mm",
            "up": "+Z",
            "frame": "CAD Z-up; GLB root node rotates to glTF Y-up; layer nodes are in CAD frame",
            "bbox": [[round(bb.min.X, 6), round(bb.min.Y, 6), round(bb.min.Z, 6)],
                     [round(bb.max.X, 6), round(bb.max.Y, 6), round(bb.max.Z, 6)]],
            "source": comp.params.get("_source"),
            "levels": comp.levels,
        },
        "explode": {"step_mm": comp.explode_step_mm},
        "layers": layers,
        "presets": comp.presets,
        **({"physics": comp.physics} if comp.physics else {}),
    }


def export_variant(comp: Component, out_dir: Path, variant_files: dict[str, str],
                   tess: dict, write_step: bool = True) -> dict[str, MeshData]:
    materials = load_materials()
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = f"{comp.id}_{comp.variant}"
    meshes = mesh_component(comp, tess)
    write_glb(comp, meshes, materials, out_dir / f"{stem}.glb")
    meta = build_metadata(comp, materials, variant_files)
    (out_dir / f"{stem}.json").write_text(json.dumps(meta, indent=2))
    if write_step:
        solids = []
        for layer in comp.layers:
            shape = layer.shape
            shape.label = layer.id
            solids.append(shape)
        export_step(Compound(solids, label=comp.id), out_dir / f"{stem}.step")
    return meshes
