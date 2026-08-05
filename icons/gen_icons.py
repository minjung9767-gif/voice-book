"""별밤책 - PWA 아이콘 생성 스크립트.
밤하늘 네이비 배경 + 별 + '동화책 표지'(금색 테두리 + 큰 초승달·별 엠블럼).
오른쪽 모서리에 페이지 결을 붙여 책 두께를 은은하게 표현.
필요할 때 다시 실행하면 아이콘을 새로 만든다.
사용: python3 gen_icons.py   (Pillow 필요)
"""
import math
from PIL import Image, ImageDraw, ImageFilter

SS = 4  # 슈퍼샘플링 배율 (선을 매끄럽게)

NAVY_T = (78, 92, 168)    # 밤하늘 위 인디고
NAVY_B = (22, 28, 70)     # 깊은 남색
PLUM = (46, 40, 96)       # 책 표지
SPINE = (34, 30, 74)      # 책등(어두운 남색)
GOLD = (255, 214, 132)    # 금색 (테두리·달·별)
CREAM = (248, 244, 233)   # 페이지 옆면
PAGE_LINE = (206, 199, 180)  # 페이지 결 선


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def paste_color(img, mask, color):
    layer = Image.new("RGBA", img.size, tuple(color) + (255,))
    img.paste(layer, (0, 0), mask)


def crescent_mask(S, cx, cy, r, cut=0.62, ang=0.0):
    """초승달 알파 마스크: 원에서 살짝 비낀 원을 빼서 만든다."""
    m = Image.new("L", (S, S), 0)
    d = ImageDraw.Draw(m)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=255)
    ox, oy = math.cos(ang) * r * cut, math.sin(ang) * r * cut
    d.ellipse([cx - r + ox, cy - r + oy, cx + r + ox, cy + r + oy], fill=0)
    return m


def star_pts(cx, cy, r, inner=0.42, rot=-90):
    return [(cx + (r if i % 2 == 0 else r * inner) * math.cos(math.radians(rot + i * 36)),
             cy + (r if i % 2 == 0 else r * inner) * math.sin(math.radians(rot + i * 36)))
            for i in range(10)]


def soft_glow(img, draw_fn, blur, alpha):
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw_fn(ImageDraw.Draw(layer))
    layer = layer.filter(ImageFilter.GaussianBlur(blur))
    layer.putalpha(layer.split()[3].point(lambda p: p * alpha // 255))
    img.alpha_composite(layer)


def draw_icon(size, maskable=False):
    S = size * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 배경 그라데이션
    for y in range(S):
        d.line([(0, y), (S, y)], fill=lerp(NAVY_T, NAVY_B, y / S))

    cx = S / 2
    cs = 0.84 if maskable else 1.0   # 마스커블은 안전영역 위해 콘텐츠 축소

    # 작은 별들
    for (sx, sy, sr) in [(0.18, 0.16, 0.012), (0.84, 0.20, 0.013), (0.80, 0.82, 0.011)]:
        r = S * sr
        d.ellipse([S * sx - r, S * sy - r, S * sx + r, S * sy + r], fill=(255, 250, 228, 230))

    # ---- 책 표지 ----
    bw, bh = S * 0.56 * cs, S * 0.66 * cs
    x0, y0 = cx - bw / 2, S * 0.50 - bh / 2
    d.rounded_rectangle([x0, y0, x0 + bw, y0 + bh], radius=int(S * 0.06 * cs), fill=PLUM)
    # 책등(왼쪽)
    d.rounded_rectangle([x0, y0, x0 + S * 0.05 * cs, y0 + bh], radius=int(S * 0.02 * cs), fill=SPINE)
    # 금색 테두리
    inset = S * 0.045 * cs
    d.rounded_rectangle([x0 + inset, y0 + inset, x0 + bw - inset, y0 + bh - inset],
                        radius=int(S * 0.04 * cs), outline=GOLD, width=max(3, int(S * 0.008 * cs)))
    # 오른쪽 모서리 페이지 결 (표지에 붙은 얇은 크림 띠 + 결 선)
    ew = S * 0.02 * cs
    d.rounded_rectangle([x0 + bw - ew, y0 + S * 0.05 * cs, x0 + bw, y0 + bh - S * 0.05 * cs],
                        radius=int(S * 0.008 * cs), fill=CREAM)
    for fy in (0.22, 0.40, 0.58, 0.76):
        yy = y0 + S * 0.05 * cs + (bh - S * 0.10 * cs) * fy
        d.line([(x0 + bw - ew, yy), (x0 + bw, yy)], fill=PAGE_LINE, width=max(1, int(S * 0.004 * cs)))

    # ---- 엠블럼: 큰 초승달 + 별 ----
    mcx, mcy, mr = cx - S * 0.01 * cs, S * 0.50, S * 0.15 * cs
    soft_glow(img, lambda g: g.ellipse([mcx - mr, mcy - mr, mcx + mr, mcy + mr], fill=GOLD + (255,)),
              blur=S * 0.02, alpha=60)
    paste_color(img, crescent_mask(S, mcx, mcy, mr, cut=0.62, ang=math.radians(-20)), GOLD)
    d.polygon(star_pts(mcx + mr * 1.02, mcy - mr * 0.72, S * 0.042 * cs), fill=GOLD)

    # 둥근 모서리(any 용도) / 마스커블·애플은 꽉 채움
    if not maskable:
        m = Image.new("L", (S, S), 0)
        ImageDraw.Draw(m).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.23), fill=255)
        img.putalpha(m)

    return img.resize((size, size), Image.LANCZOS)


def draw_apple(size):
    # iOS는 둥근모서리를 시스템이 처리 → 꽉 찬 사각(불투명)
    return draw_icon(size, maskable=True).convert("RGB")


if __name__ == "__main__":
    draw_icon(192).save("icon-192.png")
    draw_icon(512).save("icon-512.png")
    draw_icon(512, maskable=True).save("icon-maskable-512.png")
    draw_apple(180).save("apple-touch-icon.png")
    print("아이콘 생성 완료")
