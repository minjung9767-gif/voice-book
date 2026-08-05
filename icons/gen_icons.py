"""별밤책 - PWA 아이콘 생성 스크립트.
밤하늘 네이비 배경 + 별 + 초승달 + 펼친 책(크림색).
'녹음/마이크'가 아니라 '책' 느낌을 살렸다.
필요할 때 다시 실행하면 아이콘을 새로 만든다.
사용: python3 gen_icons.py
"""
from PIL import Image, ImageDraw

SS = 4  # 슈퍼샘플링 배율 (선을 매끄럽게)


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def paste_color(img, mask, color):
    """알파 마스크(mask, 'L') 자리에 단색(color)을 그라데이션 위로 올린다."""
    layer = Image.new("RGBA", img.size, color + (255,))
    img.paste(layer, (0, 0), mask)


def draw_icon(size, maskable=False):
    S = size * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    top = (74, 86, 160)     # 밤하늘 인디고
    bot = (22, 28, 68)      # 깊은 남색
    for y in range(S):
        d.line([(0, y), (S, y)], fill=lerp(top, bot, y / S))

    # 크림 책보다 콘텐츠를 살짝 작게(마스커블은 안전영역 확보)
    scale = 0.80 if maskable else 0.94
    cx = S / 2

    # ---- 작은 별들 (밤하늘 장식) ----
    star = (255, 250, 225, 235)
    for (sx, sy, sr) in [(0.20, 0.24, 0.014), (0.83, 0.22, 0.018),
                         (0.72, 0.63, 0.013), (0.16, 0.66, 0.012),
                         (0.30, 0.16, 0.010)]:
        r = S * sr
        d.ellipse([S * sx - r, S * sy - r, S * sx + r, S * sy + r], fill=star)

    cream = (247, 243, 232)   # 책 페이지 크림색
    ink = (120, 132, 178)     # 페이지 위 글줄(은은한 남보라)

    # ---- 초승달 (책 위, 은은하게) ----
    moon_mask = Image.new("L", (S, S), 0)
    md = ImageDraw.Draw(moon_mask)
    mx, my, mr = cx, S * (0.50 - 0.235 * scale), S * 0.075 * scale
    md.ellipse([mx - mr, my - mr, mx + mr, my + mr], fill=255)
    off = mr * 0.62
    md.ellipse([mx - mr + off, my - mr - off * 0.2,
                mx + mr + off, my + mr - off * 0.2], fill=0)  # 오른쪽을 파서 초승달
    paste_color(img, moon_mask, (245, 240, 224))

    # ---- 펼친 책 ----
    # 중심에서 살짝 벌어진 두 페이지. 위/아래가 스파인(중앙)으로 부드럽게 처짐.
    w = S * 0.40 * scale          # 한 페이지 가로
    gap = S * 0.018 * scale       # 중앙 스파인 틈
    y_ct = S * (0.50 + 0.02 * scale)   # 중앙 위 (살짝 아래 → 계곡)
    y_ot = S * (0.50 - 0.04 * scale)   # 바깥 위
    y_ob = S * (0.50 + 0.24 * scale)   # 바깥 아래
    y_cb = S * (0.50 + 0.30 * scale)   # 중앙 아래 (더 처짐 → 책이 벌어진 느낌)

    left = [
        (cx - gap, y_ct),
        (cx - w, y_ot),
        (cx - w, y_ob),
        (cx - gap, y_cb),
    ]
    right = [(S - x, y) for (x, y) in left]  # 좌우 대칭

    d.polygon(left, fill=cream)
    d.polygon(right, fill=cream)

    # 페이지 위 글줄 3개씩 (책 느낌)
    lw = max(2, int(S * 0.012))
    for i, fy in enumerate((0.30, 0.52, 0.74)):
        # 각 페이지 안쪽에서 바깥쪽으로, 페이지 기울기에 맞춰 살짝 기울임
        ty = y_ct + (y_cb - y_ct) * 0.18 + (y_ob - y_ot) * 0.0
        yy_in = y_ct + (y_cb - y_ct) * fy
        yy_out = y_ot + (y_ob - y_ot) * fy
        inset = w * 0.14
        # 왼쪽 페이지 글줄
        d.line([(cx - gap - inset, yy_in), (cx - w + inset, yy_out)], fill=ink, width=lw)
        # 오른쪽 페이지 글줄
        d.line([(cx + gap + inset, yy_in), (cx + w - inset, yy_out)], fill=ink, width=lw)

    # 중앙 스파인(책등) 살짝 강조
    d.line([(cx, y_ct - S * 0.005), (cx, y_cb)], fill=(228, 222, 205), width=max(2, int(S * 0.01)))

    # ---- 둥근 모서리(any 용도) / 마스커블은 꽉 채움 ----
    if not maskable:
        r = int(S * 0.23)
        corner = Image.new("L", (S, S), 0)
        ImageDraw.Draw(corner).rounded_rectangle([0, 0, S - 1, S - 1], radius=r, fill=255)
        img.putalpha(corner)

    return img.resize((size, size), Image.LANCZOS)


def draw_apple(size):
    # iOS는 둥근모서리를 시스템이 처리 → 꽉 찬 사각(불투명) 배경
    return draw_icon(size, maskable=True).convert("RGB")


if __name__ == "__main__":
    draw_icon(192).save("icon-192.png")
    draw_icon(512).save("icon-512.png")
    draw_icon(512, maskable=True).save("icon-maskable-512.png")
    draw_apple(180).save("apple-touch-icon.png")
    print("아이콘 생성 완료")
