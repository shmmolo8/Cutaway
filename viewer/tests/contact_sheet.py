"""Tile .test-output/screenshots/<component>/<variant>/<preset>.png into one sheet per component."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[2] / ".test-output"
shots = root / "screenshots"
W = 420
for comp_dir in sorted(p for p in shots.iterdir() if p.is_dir() and p.name != "scenarios"):
    variants = sorted(d.name for d in comp_dir.iterdir() if d.is_dir())
    presets = [p.stem for p in sorted((comp_dir / variants[0]).glob("*.png"))]
    order = ["exterior", "longitudinal", "transverse", "plan_trim", "plan_overlap", "exploded"]
    presets = [p for p in order if p in presets] + [p for p in presets if p not in order]
    cells = []
    for v in variants:
        row = []
        for p in presets:
            im = Image.open(comp_dir / v / f"{p}.png").convert("RGB")
            im = im.crop((270, 44, im.width - 300, im.height))   # the 3D viewport column
            h = int(im.height * W / im.width)
            row.append(im.resize((W, h)))
        cells.append(row)
    h = cells[0][0].height
    sheet = Image.new("RGB", (W * len(presets), (h + 22) * len(variants)), "#111")
    d = ImageDraw.Draw(sheet)
    for r, (v, row) in enumerate(zip(variants, cells)):
        for c, (p, im) in enumerate(zip(presets, row)):
            sheet.paste(im, (c * W, r * (h + 22) + 22))
            d.text((c * W + 6, r * (h + 22) + 5), f"{v} / {p}", fill="#ddd")
    out = shots / f"{comp_dir.name}_sheet.png"
    sheet.save(out)
    print(out)
