/** Engineering format: 1.23 kΩ, 4.7 µF, 12 pC ... */
export function fmt(v: number, unit: string): string {
  const a = Math.abs(v);
  const [k, p] = a >= 1e9 ? [1e-9, "G"] : a >= 1e6 ? [1e-6, "M"] : a >= 1e3 ? [1e-3, "k"] : a >= 1 || a === 0 ? [1, ""] : a >= 1e-3 ? [1e3, "m"]
    : a >= 1e-6 ? [1e6, "µ"] : a >= 1e-9 ? [1e9, "n"] : [1e12, "p"];
  return `${+(v * k).toPrecision(3)} ${p}${unit}`;
}
