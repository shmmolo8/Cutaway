import * as THREE from "three";

/** Material roles for the physics overlay (a `PHYS_ROLE` define in the shader). */
export const ROLE = { FILM: 1, POSITIVE: 2, NEGATIVE: 3, BODY: 4, TAP: 5 } as const;   // TAP: a wiper at uTapV

/**
 * Uniforms shared by every physics-aware material. The field texture holds, per film
 * cell: R = potential (0..1), G = heat |J|^2 (normalised), B = blurred heat (for the
 * illustrative spread into the body), A = conductor mask (0 in the trim kerf).
 */
export function makeUniforms() {
  const lin = (hex: string) => new THREE.Color(hex);           // Color() stores linear values
  return {
    uFieldTex: { value: null as THREE.Texture | null },
    uDomainMin: { value: new THREE.Vector2() },
    uDomainSize: { value: new THREE.Vector2(1, 1) },
    uWorldToCad: { value: new THREE.Matrix4() },
    uOn: { value: 0 },
    uVolt: { value: 0 },          // terminals/electrodes coloured (stage 1)
    uField: { value: 0 },         // potential spreads across the film (stage 2)
    uShowPot: { value: 1 },
    uShowLines: { value: 1 },
    uLineCount: { value: 10 },
    uHeatMix: { value: 0 },       // film shows heat instead of potential (stage 4)
    uHeatGain: { value: 1 },      // brightness from power vs rating
    uHeatEmit: { value: 0.6 },    // glow (grows past the rating)
    uSpread: { value: 0 },        // heat reaches substrate / terminals (stage 4b, illustrative)
    uTermHeat: { value: 0.4 },
    uZFilm: { value: 0 },
    uLambda: { value: 0.1 },
    uRed: { value: lin("#e0302a") },
    uBlack: { value: lin("#0b0b0c") },
    uInsul: { value: lin("#2a3d52") },
    uLineColor: { value: lin("#f5f5f0") },
    uPalette: { value: 0 },       // magnitude palette: 0 = heat, 1 = electric field, 2 = magnetic
    uLineAlpha: { value: 0.85 },
    uAcScale: { value: 1 },       // instantaneous V(t)/V0 applied to the + side (1 for DC)
    uCore: { value: 1 },          // magnetics: blend air-core (B channel) -> ferrite (G channel) field
    uBlue: { value: lin("#2f7bff") },
    uCyl: { value: new THREE.Vector3(0, 0, 1) },  // film on a cylinder: axis y, axis z, film radius
    uCylX: { value: new THREE.Vector2(0, 1) },    // ... axis-x centre, contact half-length
    uMetalHeat: { value: 1 },     // 1: heat/field view replaces the metal's polarity colour; 0: keep it
    uRadialCut: { value: new THREE.Vector4(0, 0, 1e9, 0) },   // PHYS_RCUT: centre xy, radius, enabled
    uCutColor: { value: lin("#b58c5a") },
    uCutAxis: { value: new THREE.Vector2(0, 0) }, // (0,0): radial cut; else distance along this axis
    uTapV: { value: 0.5 },        // potential (0..1) of TAP-role metal (potentiometer wiper)
  };
}
export type PhysicsUniforms = ReturnType<typeof makeUniforms>;

const COMMON = /* glsl */ `
uniform sampler2D uFieldTex;
uniform vec2 uDomainMin, uDomainSize;
uniform mat4 uWorldToCad;
uniform float uOn, uVolt, uField, uShowPot, uShowLines, uLineCount, uHeatMix, uHeatGain, uHeatEmit, uSpread, uTermHeat, uZFilm, uLambda;
uniform vec3 uRed, uBlack, uInsul, uLineColor;
uniform float uPalette, uLineAlpha, uAcScale, uCore, uMetalHeat;
uniform vec4 uRadialCut;
uniform vec2 uCutAxis;
uniform float uTapV;
uniform vec3 uCutColor;
// dark -> deep green -> teal -> yellow-green -> white (magnetic flux density)
vec3 magRamp(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c0 = vec3(0.01, 0.02, 0.015), c1 = vec3(0.02, 0.22, 0.10), c2 = vec3(0.05, 0.65, 0.45),
       c3 = vec3(0.75, 0.95, 0.25), c4 = vec3(1.0, 1.0, 0.9);
  if (t < 0.3) return mix(c0, c1, t / 0.3);
  if (t < 0.6) return mix(c1, c2, (t - 0.3) / 0.3);
  if (t < 0.85) return mix(c2, c3, (t - 0.6) / 0.25);
  return mix(c3, c4, (t - 0.85) / 0.15);
}
uniform vec3 uBlue;
// diverging potential: -1 blue, 0 black, +1 red
vec3 potColor(float p) {
  return p >= 0.0 ? mix(uBlack, uRed, p) : mix(uBlack, uBlue, -p);
}
varying vec3 vCad;
uniform vec3 uCyl;
uniform vec2 uCylX;
#if PHYS_PLANE == 1
#define PHYS_P(v) (v).xz
#elif PHYS_PLANE == 2
// film on a cylinder along X, unrolled: (x, arc length), angle from +Y towards +Z
vec2 physCyl(vec3 v) {
  float a = atan(v.z - uCyl.y, v.y - uCyl.x);
  return vec2(v.x, (a < 0.0 ? a + 6.28318530718 : a) * uCyl.z);
}
#define PHYS_P(v) physCyl(v)
#else
#define PHYS_P(v) (v).xy
#endif
// depth below the film (heat spreading into the body) and distance from it (terminals)
float physDepth(vec3 v) {
#if PHYS_PLANE == 2
  return max(0.0, uCyl.z - length(v.yz - uCyl.xy));
#elif PHYS_PLANE == 1
  return max(0.0, v.y - uZFilm);           // film in the XZ plane, substrate behind it (+y)
#else
  return max(0.0, uZFilm - v.z);
#endif
}
float physDist(vec3 v) {
#if PHYS_PLANE == 2
  return abs(uCyl.z - length(v.yz - uCyl.xy)) + max(0.0, abs(v.x - uCylX.x) - uCylX.y);
#elif PHYS_PLANE == 1
  return abs(v.y - uZFilm);
#else
  return abs(uZFilm - v.z);
#endif
}
// dark navy -> violet -> blue -> cyan -> white (field strength; distinct from heat)
vec3 fieldRamp(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c0 = vec3(0.01, 0.01, 0.03), c1 = vec3(0.12, 0.02, 0.30), c2 = vec3(0.10, 0.30, 1.0),
       c3 = vec3(0.35, 0.90, 1.0), c4 = vec3(0.95, 1.0, 1.0);
  if (t < 0.3) return mix(c0, c1, t / 0.3);
  if (t < 0.6) return mix(c1, c2, (t - 0.3) / 0.3);
  if (t < 0.85) return mix(c2, c3, (t - 0.6) / 0.25);
  return mix(c3, c4, (t - 0.85) / 0.15);
}
// dark -> deep red -> orange -> yellow -> white, like glowing metal
vec3 heatRamp(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c0 = vec3(0.02, 0.012, 0.01), c1 = vec3(0.40, 0.03, 0.0), c2 = vec3(1.0, 0.33, 0.0),
       c3 = vec3(1.0, 0.78, 0.18), c4 = vec3(1.0, 0.97, 0.86);
  if (t < 0.3) return mix(c0, c1, t / 0.3);
  if (t < 0.6) return mix(c1, c2, (t - 0.3) / 0.3);
  if (t < 0.85) return mix(c2, c3, (t - 0.6) / 0.25);
  return mix(c3, c4, (t - 0.85) / 0.15);
}
`;

const FRAG_COLOR = /* glsl */ `
#include <color_fragment>
vec3 physEm = vec3(0.0);
float physMetalMix = 0.0;
#if PHYS_ROLE == 1
{
  vec2 uv = (PHYS_P(vCad) - uDomainMin) / uDomainSize;
  float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  vec4 f = texture2D(uFieldTex, clamp(uv, 0.0, 1.0));
  float a = abs(f.r - 0.5) * 2.0;                       // 1 at the contacts, 0 mid-film
  float thr = 1.0 - uField;
  float reveal = smoothstep(thr - 0.06, thr, a);         // field spreads in from both ends
  vec3 pot = potColor(uAcScale * f.r);
  vec3 col = mix(diffuseColor.rgb, pot, uShowPot * uVolt * reveal);
  float ht = (uPalette > 1.5 ? mix(f.b, f.g, uCore) : f.g) * uHeatGain;
  vec3 h = uPalette > 1.5 ? magRamp(ht) : uPalette > 0.5 ? fieldRamp(ht) : heatRamp(ht);
  col = mix(col, h, uHeatMix);
  float lv = f.r * uLineCount;
  float fr = fract(lv);
  float d = min(fr, 1.0 - fr);
  float w = fwidth(lv) + 1e-4;
  float line = (1.0 - smoothstep(w * 0.6, w * 1.7, d)) * uShowLines * uField * reveal * step(0.02, f.r) * step(f.r, 0.98);
  col = mix(col, uLineColor, line * uLineAlpha);
  float cond = smoothstep(0.3, 0.7, f.a);
  col = mix(uInsul, col, cond);
  diffuseColor.rgb = mix(diffuseColor.rgb, col, inside * uOn);
  // glow grows much faster than temperature, so past the rating the hot spot flares first
  float hc = min(ht, 1.2);
  physEm = h * (0.35 * hc + 0.65 * hc * hc * hc) * uHeatMix * uHeatEmit * cond * inside * uOn;
  physMetalMix = inside * uOn;
}
#elif PHYS_ROLE == 2 || PHYS_ROLE == 3 || PHYS_ROLE == 5
{
  #if PHYS_ROLE == 2
  vec3 target = potColor(uAcScale);
  #elif PHYS_ROLE == 5
  vec3 target = potColor(uTapV);
  #else
  vec3 target = uBlack;
  #endif
  float k = uOn * uVolt * uShowPot * (1.0 - uHeatMix * uMetalHeat);   // heat view: metal shows only heat
  diffuseColor.rgb = mix(diffuseColor.rgb, target, k);
  physMetalMix = k;
  float t = uSpread * uTermHeat * exp(-physDist(vCad) / (uLambda * 4.0));
  physEm = heatRamp(t) * t * uOn;
}
#elif PHYS_ROLE == 4
{
  vec2 uv = clamp((PHYS_P(vCad) - uDomainMin) / uDomainSize, 0.0, 1.0);
  float hb = texture2D(uFieldTex, uv).b;
  float t = uSpread * hb * uHeatGain * exp(-physDepth(vCad) / uLambda);
  diffuseColor.rgb = mix(diffuseColor.rgb, heatRamp(t), min(1.0, t) * 0.65 * uOn);
  physEm = heatRamp(t) * t * 0.6 * uOn;
}
#endif
#ifdef PHYS_RCUT
{
  // foil beyond the design's length (radius limit about the winding axis) shows as bare paper
  vec2 rel = vCad.xy - uRadialCut.xy;
  float dist = dot(uCutAxis, uCutAxis) > 0.5 ? dot(rel, uCutAxis) : length(rel);
  float foilOn = 1.0 - step(uRadialCut.z, dist) * uRadialCut.w;
  diffuseColor.rgb = mix(uCutColor, diffuseColor.rgb, foilOn);
  physEm *= foilOn;
  physMetalMix *= foilOn;
}
#endif
`;

/** Make a standard material physics-aware (idempotent per material). */
export function injectPhysics(mat: THREE.MeshStandardMaterial, role: number, U: PhysicsUniforms,
  plane: "xy" | "xz" | "cyl" = "xy", radialCut = false): void {
  mat.defines = { ...(mat.defines ?? {}), PHYS_ROLE: role, PHYS_PLANE: plane === "xz" ? 1 : plane === "cyl" ? 2 : 0 };
  if (radialCut) mat.defines.PHYS_RCUT = 1;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, U);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${COMMON}`)
      .replace("#include <project_vertex>",
        "#include <project_vertex>\nvCad = (uWorldToCad * modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${COMMON}`)
      .replace("#include <color_fragment>", FRAG_COLOR)
      .replace("#include <metalnessmap_fragment>",
        "#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, 0.1, physMetalMix);")
      .replace("#include <roughnessmap_fragment>",
        "#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.55, physMetalMix);")
      .replace("#include <emissivemap_fragment>",
        "#include <emissivemap_fragment>\ntotalEmissiveRadiance += physEm;");
  };
  mat.customProgramCacheKey = () => `physics-${role}-${plane}-${radialCut ? 1 : 0}`;
  mat.needsUpdate = true;
}
