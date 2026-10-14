import type { LayerMeta } from "./types";

function fmtUm(um: number): string {
  return um >= 100 ? `${(um / 1000).toFixed(3)} mm` : `${+um.toFixed(2)} µm`;
}

/** Info card for the selected layer. Content comes straight from metadata. */
export class InfoCard {
  private el: HTMLElement;
  onClose: () => void = () => {};

  constructor(el: HTMLElement) {
    this.el = el;
  }

  show(l: LayerMeta | null, variant: string): void {
    if (!l) {
      this.el.hidden = true;
      return;
    }
    const rows: [string, string][] = [];
    // wires and other non-film parts have no layer thickness
    if (l.thickness_true_um !== null && l.thickness_model_um !== null) {
      const scaled = variant !== "true_scale" && Math.abs(l.thickness_model_um - l.thickness_true_um) > 1e-6;
      rows.push(["Thickness", fmtUm(l.thickness_true_um) + (l.derived ? " (derived)" : "")]);
      if (scaled) rows.push(["Shown as", `${fmtUm(l.thickness_model_um)} (×${(l.thickness_model_um / l.thickness_true_um).toFixed(1)})`]);
    }
    rows.push(["Volume", `${(l.volume_mm3 * 1e3).toPrecision(3)} × 10⁻³ mm³`]);
    if (l.group) rows.push(["Group", l.group.replace(/_/g, " ")]);

    this.el.innerHTML = "";
    const close = document.createElement("button");
    close.className = "icon-btn close";
    close.setAttribute("aria-label", "Close");
    close.textContent = "✕";
    close.addEventListener("click", () => this.onClose());

    const h = document.createElement("h3");
    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background = l.color;
    h.append(sw, document.createTextNode(l.name));

    const mat = document.createElement("div");
    mat.className = "material";
    mat.textContent = l.material;

    const fn = document.createElement("p");
    fn.textContent = l.function;

    const dl = document.createElement("dl");
    for (const [k, v] of rows) {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      dl.append(dt, dd);
    }
    this.el.append(close, h, mat, fn, dl);
    this.el.hidden = false;
  }
}
