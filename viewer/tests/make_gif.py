"""Assemble .test-output/gif/*.png (from readme.spec.ts) into the README's looping GIF."""
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parents[2]
frames = [Image.open(p).convert("RGB") for p in sorted((root / ".test-output" / "gif").glob("*.png"))]
w = 560
frames = [f.resize((w, round(f.height * w / f.width)), Image.LANCZOS) for f in frames]
# one palette from every frame (phase 0 alone has no red/blue), shared so colours don't flicker
strip = Image.new("RGB", (w, sum(f.height for f in frames)))
for k, f in enumerate(frames):
    strip.paste(f, (0, k * f.height))
pal = strip.quantize(colors=160, method=Image.Quantize.MEDIANCUT)
out = root / ".github" / "images" / "mlcc_ac.gif"
q = [f.quantize(palette=pal, dither=Image.Dither.NONE) for f in frames]
q[0].save(out, save_all=True, append_images=q[1:], duration=90, loop=0, optimize=True)
print(out, f"{out.stat().st_size / 1e6:.2f} MB", len(q), "frames")
