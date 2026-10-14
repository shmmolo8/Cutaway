import type { ComponentModel, LayerView } from "./model";

const EYE = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_OFF = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.9 17.9A10.1 10.1 0 0 1 12 19c-7 0-11-7-11-7a18.5 18.5 0 0 1 5.1-5.9M9.9 5.2A9.1 9.1 0 0 1 12 5c7 0 11 7 11 7a18.5 18.5 0 0 1-2.2 3.2M1 1l22 22"/></svg>`;
const ISOLATE = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>`;

export interface PanelCallbacks {
  onToggle(id: string, visible: boolean): void;
  onIsolate(id: string): void;
  onShowAll(): void;
  onHover(id: string | null): void;
  onSelect(id: string): void;
}

/** Layer list, driven by metadata only. */
export class LayerPanel {
  private el: HTMLElement;
  private rows = new Map<string, HTMLElement>();
  private cb: PanelCallbacks;

  constructor(el: HTMLElement, cb: PanelCallbacks) {
    this.el = el;
    this.cb = cb;
  }

  build(model: ComponentModel): void {
    this.el.innerHTML = "";
    this.rows.clear();
    const h = document.createElement("h2");
    h.textContent = "Layers";
    const all = document.createElement("button");
    all.className = "text-btn";
    all.textContent = "Show all";
    all.addEventListener("click", () => this.cb.onShowAll());
    h.append(all);
    this.el.append(h);

    const list = document.createElement("div");
    list.setAttribute("role", "list");
    for (const l of model.layers) list.append(this.row(l));
    list.addEventListener("mouseleave", () => this.cb.onHover(null));
    this.el.append(list);
  }

  private row(l: LayerView): HTMLElement {
    const row = document.createElement("div");
    row.className = "layer-row";
    row.dataset.layer = l.meta.id;
    row.setAttribute("role", "listitem");
    row.title = `${l.meta.name} — ${l.meta.material}`;

    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background = l.meta.color;
    if (l.meta.opacity < 1) sw.style.opacity = "0.7";

    const name = document.createElement("span");
    name.className = "layer-name";
    name.textContent = l.meta.name;

    const iso = document.createElement("button");
    iso.className = "icon-btn isolate";
    iso.innerHTML = ISOLATE;
    iso.title = "Isolate";
    iso.setAttribute("aria-label", `Isolate ${l.meta.name}`);
    iso.addEventListener("click", (e) => { e.stopPropagation(); this.cb.onIsolate(l.meta.id); });

    const eye = document.createElement("button");
    eye.className = "icon-btn eye";
    eye.title = "Show / hide";
    eye.setAttribute("aria-label", `Show or hide ${l.meta.name}`);
    eye.addEventListener("click", (e) => { e.stopPropagation(); this.cb.onToggle(l.meta.id, !l.visible); });

    row.append(sw, name, iso, eye);
    row.addEventListener("mouseenter", () => this.cb.onHover(l.meta.id));
    row.addEventListener("click", () => this.cb.onSelect(l.meta.id));
    this.rows.set(l.meta.id, row);
    this.update(l, false);
    return row;
  }

  /** Refresh one row's visibility/isolation state. */
  update(l: LayerView, isolated: boolean): void {
    const row = this.rows.get(l.meta.id);
    if (!row) return;
    row.classList.toggle("hidden", !l.visible);
    row.querySelector(".eye")!.innerHTML = l.visible ? EYE : EYE_OFF;
    row.querySelector(".isolate")!.classList.toggle("on", isolated);
  }

  setHover(id: string | null): void {
    for (const [k, r] of this.rows) r.classList.toggle("hover", k === id);
  }

  setSelected(id: string | null): void {
    for (const [k, r] of this.rows) r.classList.toggle("selected", k === id);
    if (id) this.rows.get(id)?.scrollIntoView({ block: "nearest" });
  }
}
