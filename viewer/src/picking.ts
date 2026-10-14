import * as THREE from "three";
import type { ComponentModel, LayerView } from "./model";
import type { SectionTool } from "./section";

export interface PickResult {
  layer: LayerView;
  point: THREE.Vector3;
  distance: number;
  onCap: boolean;
}

const raycaster = new THREE.Raycaster();
const PARITY_DIR = new THREE.Vector3(0.5773, 0.5774, 0.5775).normalize();   // skewed: avoids edges
const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpC = new THREE.Vector3(), tmpHit = new THREE.Vector3();

/**
 * Pick the layer under a pointer (NDC coords).
 *  - Surface hits on the clipped-away side of the plane are ignored.
 *  - Cap faces are stencil-only, so they're picked analytically: intersect the ray
 *    with the plane and test which (visible) solid contains that point.
 */
export function pick(ndc: THREE.Vector2, camera: THREE.Camera, model: ComponentModel, section: SectionTool): PickResult | null {
  raycaster.setFromCamera(ndc, camera);
  const meshes = model.layers.filter((l) => l.visible).map((l) => l.mesh);
  let best: PickResult | null = null;
  for (const hit of raycaster.intersectObjects(meshes, false)) {
    if (!section.keeps(hit.point, 1e-5)) continue;
    const layer = model.byMesh.get(hit.object);
    if (layer) best = { layer, point: hit.point.clone(), distance: hit.distance, onCap: false };
    break;
  }
  if (section.enabled) {
    const p = raycaster.ray.intersectPlane(section.plane, new THREE.Vector3());
    if (p) {
      const d = p.distanceTo(raycaster.ray.origin);
      if (!best || d < best.distance - 1e-6) {
        for (const layer of model.layers) {
          if (layer.visible && containsPoint(layer.mesh, p)) {
            best = { layer, point: p, distance: d, onCap: true };
            break;
          }
        }
      }
    }
  }
  return best;
}

/** Point-in-closed-mesh by ray parity (meshes are watertight by construction). */
export function containsPoint(mesh: THREE.Mesh, worldPoint: THREE.Vector3): boolean {
  const geom = mesh.geometry;
  if (!geom.boundingBox) geom.computeBoundingBox();
  const local = mesh.worldToLocal(worldPoint.clone());
  if (!geom.boundingBox!.containsPoint(local)) return false;
  const pos = geom.getAttribute("position");
  const index = geom.getIndex();
  const ray = new THREE.Ray(local, PARITY_DIR);
  const n = index ? index.count : pos.count;
  let crossings = 0;
  for (let i = 0; i < n; i += 3) {
    const ia = index ? index.getX(i) : i, ib = index ? index.getX(i + 1) : i + 1, ic = index ? index.getX(i + 2) : i + 2;
    tmpA.fromBufferAttribute(pos, ia);
    tmpB.fromBufferAttribute(pos, ib);
    tmpC.fromBufferAttribute(pos, ic);
    if (ray.intersectTriangle(tmpA, tmpB, tmpC, false, tmpHit)) crossings++;
  }
  return crossings % 2 === 1;
}
