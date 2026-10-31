# -*- coding: utf-8 -*-
"""生成机惨模拟器应用图标：512x512 主图 + 多尺寸 .ico。"""
import math, os
from PIL import Image, ImageDraw, ImageFilter

S = 1024  # 先大图再降采样，边缘更干净
def lerp(a, b, t): return a + (b - a) * t
def mix(c1, c2, t): return tuple(int(lerp(c1[i], c2[i], t)) for i in range(3))

def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m

def radial_bg(size):
    img = Image.new("RGB", (size, size), (0, 0, 0))
    d = ImageDraw.Draw(img)
    top = (46, 58, 92)
    bot = (16, 20, 33)
    for y in range(size):
        d.line([(0, y), (size, y)], fill=mix(top, bot, y / size))
    # 角落高光
    glow = Image.new("L", (size, size), 0)
    gd = ImageDraw.Draw(glow)
    gd.ellipse([-size * 0.35, -size * 0.55, size * 0.75, size * 0.5], fill=70)
    glow = glow.filter(ImageFilter.GaussianBlur(size * 0.12))
    img = Image.composite(Image.new("RGB", (size, size), (120, 180, 255)), img, glow.point(lambda v: int(v * 0.55)))
    return img

size = S
img = radial_bg(size).convert("RGBA")
d = ImageDraw.Draw(img, "RGBA")

cx = size * 0.5
# ---- 显示器（圆角矩形 + 描边 + 内屏渐变）
mon_w, mon_h = size * 0.60, size * 0.42
mx0, my0 = cx - mon_w / 2, size * 0.22
mx1, my1 = cx + mon_w / 2, my0 + mon_h
# 外发光
glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)
gd.rounded_rectangle([mx0 - 18, my0 - 18, mx1 + 18, my1 + 18], radius=size * 0.05, fill=(90, 169, 255, 150))
glow = glow.filter(ImageFilter.GaussianBlur(26))
img.alpha_composite(glow)
d = ImageDraw.Draw(img, "RGBA")

# 屏幕本体
d.rounded_rectangle([mx0, my0, mx1, my1], radius=size * 0.035, fill=(31, 41, 66, 255))
d.rounded_rectangle([mx0, my0, mx1, my1], radius=size * 0.035, outline=(122, 196, 255, 255), width=int(size * 0.014))
# 屏幕上一条「惨」流光
for i, (yy, alpha) in enumerate([(0.30, 90), (0.38, 60), (0.46, 35)]):
    y = my0 + mon_h * yy
    d.line([(mx0 + size * 0.05, y), (mx1 - size * 0.05, y)], fill=(122, 196, 255, alpha), width=int(size * 0.008))

# ---- 支架
stalk_w = size * 0.055
d.rounded_rectangle([cx - stalk_w / 2, my1 - 4, cx + stalk_w / 2, my1 + size * 0.115], radius=size * 0.012, fill=(74, 96, 138, 255))
base_w = size * 0.26
d.rounded_rectangle([cx - base_w / 2, my1 + size * 0.085, cx + base_w / 2, my1 + size * 0.135], radius=size * 0.022, fill=(90, 116, 168, 255))

# ---- 黄色徽章（感叹号：惨）
bx, by, br = size * 0.745, size * 0.735, size * 0.145
badge_glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
bgd = ImageDraw.Draw(badge_glow)
bgd.ellipse([bx - br * 1.35, by - br * 1.35, bx + br * 1.35, by + br * 1.35], fill=(255, 207, 92, 120))
badge_glow = badge_glow.filter(ImageFilter.GaussianBlur(22))
img.alpha_composite(badge_glow)
d = ImageDraw.Draw(img, "RGBA")
# 徽章底：径向渐变（亮黄 → 橙）
for i in range(int(br), 0, -1):
    t = i / br
    col = mix((255, 232, 140), (245, 158, 30), t)
    d.ellipse([bx - i, by - i, bx + i, by + i], fill=col + (255,))
d.ellipse([bx - br, by - br, bx + br, by + br], outline=(255, 255, 255, 90), width=int(size * 0.006))
# 感叹号
bar_w = br * 0.26
d.rounded_rectangle([bx - bar_w / 2, by - br * 0.52, bx + bar_w / 2, by + br * 0.12], radius=bar_w / 2, fill=(52, 34, 8, 255))
d.ellipse([bx - bar_w * 0.62, by + br * 0.30, bx + bar_w * 0.62, by + br * 0.30 + bar_w * 1.24], fill=(52, 34, 8, 255))

# ---- 圆角裁切 + 落影
mask = rounded_mask(size, int(size * 0.22))
out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
shadow.paste(Image.new("RGBA", (size, size), (0, 0, 0, 110)), (0, int(size * 0.012)), mask)
shadow = shadow.filter(ImageFilter.GaussianBlur(int(size * 0.018)))
out.alpha_composite(shadow)
img.putalpha(mask)
out.alpha_composite(img)

# 512 主图
os.makedirs(r"client/assets/icons", exist_ok=True)
os.makedirs(r"packaging/icons", exist_ok=True)
main = out.resize((512, 512), Image.LANCZOS)
main.save(r"client/assets/icons/app-512.png")
main.save(r"packaging/icons/jican-simulator.png")

sizes = [16, 24, 32, 48, 64, 128, 256]
icons = [out.resize((s, s), Image.LANCZOS) for s in sizes]
icons[0].save(r"packaging/icons/jican-simulator.ico", format="ICO", sizes=[(s, s) for s in sizes])
print("wrote icons", os.path.getsize(r"packaging/icons/jican-simulator.ico"), "bytes")
