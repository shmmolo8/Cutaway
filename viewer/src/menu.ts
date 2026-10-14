import type { IndexEntry } from "./types";

/** Top-bar component menu, grouped by category; driven by build/index.json. */
export class ComponentMenu {
  private btn = document.getElementById("menu-btn")!;
  private menu = document.getElementById("menu")!;
  private title = document.getElementById("title")!;
  private items = new Map<string, HTMLButtonElement>();

  constructor(entries: IndexEntry[], onPick: (id: string) => void) {
    const byCategory = new Map<string, IndexEntry[]>();
    for (const e of entries) byCategory.set(e.category, [...(byCategory.get(e.category) ?? []), e]);
    for (const [category, list] of byCategory) {
      const h = document.createElement("h4");
      h.textContent = category;
      this.menu.append(h);
      for (const e of list) {
        const item = document.createElement("button");
        item.className = "menu-item";
        item.dataset.component = e.id;
        const name = document.createElement("div");
        name.className = "name";
        name.textContent = e.name;
        const desc = document.createElement("div");
        desc.className = "desc";
        desc.textContent = e.description;
        item.append(name, desc);
        item.addEventListener("click", () => { this.close(); onPick(e.id); });
        this.menu.append(item);
        this.items.set(e.id, item);
      }
    }
    this.btn.addEventListener("click", (ev) => { ev.stopPropagation(); this.menu.hidden ? this.open() : this.close(); });
    document.addEventListener("click", (ev) => { if (!this.menu.contains(ev.target as Node)) this.close(); });
    document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") this.close(); });
  }

  setActive(entry: IndexEntry): void {
    this.title.textContent = entry.name;
    for (const [id, el] of this.items) el.classList.toggle("active", id === entry.id);
  }

  open(): void {
    this.menu.hidden = false;
    this.btn.setAttribute("aria-expanded", "true");
    (this.menu.querySelector(".menu-item.active") as HTMLElement | null)?.focus();
  }

  close(): void {
    this.menu.hidden = true;
    this.btn.setAttribute("aria-expanded", "false");
  }
}
