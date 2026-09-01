#!/usr/bin/env python3
"""Генератор аватарок ботов команды.
Стиль: круг (Telegram кропит в круг), сплошной цвет + контр-цветная монограмма.
"""
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

SIZE = 512
OUT = Path(__file__).parent.parent / "avatars"
OUT.mkdir(exist_ok=True)

# (key, monogram, bg_color, fg_color, accent_dot_color_or_None)
ROLES = [
    ("orchestrator", "Д",  "#1E1B4B", "#FBBF24", None),         # тёмно-синий + золото
    ("pm",           "PM", "#0EA5E9", "#FFFFFF", "#FACC15"),    # голубой
    ("product",      "Pr", "#10B981", "#FFFFFF", "#FDE047"),    # зелёный
    ("backend",      "B",  "#374151", "#22D3EE", "#34D399"),    # графит + cyan
    ("frontend",     "F",  "#F97316", "#FFFFFF", "#FACC15"),    # оранжевый
    ("tgdev",        "TG", "#0088CC", "#FFFFFF", None),         # telegram blue
    ("aieng",        "AI", "#7C3AED", "#FFFFFF", "#F472B6"),    # фиолет + пинк
    ("qa",           "QA", "#DC2626", "#FFFFFF", "#FBBF24"),    # красный
    ("smm",          "S",  "#FACC15", "#1F2937", "#F472B6"),    # жёлтый + графит
    ("copy",         "C",  "#A16207", "#FFF7ED", "#FDE68A"),    # сепия
    ("design",       "D",  "#EC4899", "#FFFFFF", "#A78BFA"),    # розовый + лаванда
    ("perm",         "P",  "#1F2937", "#F87171", "#FBBF24"),    # тёмно-графит + сигнальный красный
]

# Подбираем доступный шрифт (macOS)
FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial Black.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/Library/Fonts/Arial Black.ttf",
]
font_path = next((p for p in FONT_CANDIDATES if Path(p).exists()), None)

def load_font(text):
    # Размер шрифта зависит от длины монограммы
    base = 320 if len(text) == 1 else 220
    if not font_path:
        return ImageFont.load_default()
    return ImageFont.truetype(font_path, base)

def hex_to_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

def make(key, mono, bg, fg, accent):
    img = Image.new("RGB", (SIZE, SIZE), hex_to_rgb(bg))
    draw = ImageDraw.Draw(img)

    # Лёгкий градиент-намёк: затемнение в правом-нижнем
    overlay = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    for r in range(0, 80, 4):
        od.ellipse(
            [SIZE - 80 - r, SIZE - 80 - r, SIZE + r, SIZE + r],
            fill=(0, 0, 0, 6),
        )
    img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")
    draw = ImageDraw.Draw(img)

    # Угловой акцент (маленький круг сверху-справа), если задан
    if accent:
        ax = SIZE - 100
        ay = 70
        draw.ellipse([ax - 30, ay - 30, ax + 30, ay + 30], fill=hex_to_rgb(accent))

    # Монограмма по центру
    font = load_font(mono)
    bbox = draw.textbbox((0, 0), mono, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    tx = (SIZE - tw) // 2 - bbox[0]
    ty = (SIZE - th) // 2 - bbox[1] - 10
    draw.text((tx, ty), mono, font=font, fill=hex_to_rgb(fg))

    out_path = OUT / f"{key}.png"
    img.save(out_path, "PNG", optimize=True)
    print(f"  {out_path.relative_to(Path.cwd())}")

print(f"Generating {len(ROLES)} avatars → {OUT}/")
for r in ROLES:
    make(*r)
print("done")
