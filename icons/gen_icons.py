"""우리 목소리 책 - PWA 아이콘 생성 스크립트.
따뜻한 색 배경 + 흰색 마이크. 필요할 때 다시 실행하면 아이콘을 새로 만든다.
사용: python3 gen_icons.py
"""
from PIL import Image, ImageDraw


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def draw_icon(size, maskable=False):
    S = size
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    top = (255, 176, 158)   # 부드러운 살구색
    bot = (255, 138, 173)   # 부드러운 분홍
    # 세로 그라데이션 배경
    for y in range(S):
        d.line([(0, y), (S, y)], fill=lerp(top, bot, y / S))

    if not maskable:
        # 둥근 모서리로 다듬기 (any 용도)
        r = int(S * 0.23)
        mask = Image.new("L", (S, S), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=r, fill=255)
        img.putalpha(mask)

    # 마스커블은 안전영역을 위해 마이크를 좀 더 작게
    scale = 0.74 if maskable else 0.88
    cx = S / 2
    w = S * 0.22 * scale          # 마이크 몸통 폭 (세로로 긴 캡슐)
    cap_top = S * (0.50 - 0.22 * scale)
    cap_bot = S * (0.50 + 0.08 * scale)
    white = (255, 255, 255, 255)

    # 마이크 몸통 (둥근 캡슐)
    d.rounded_rectangle(
        [cx - w / 2, cap_top, cx + w / 2, cap_bot],
        radius=w / 2, fill=white,
    )
    # 홀더 아치 (U자)
    arc_w = w * 1.9
    arc_top = cap_bot - w * 0.9
    arc_bot = cap_bot + w * 0.7
    lw = max(3, int(S * 0.028))
    d.arc([cx - arc_w / 2, arc_top, cx + arc_w / 2, arc_bot],
          start=20, end=160, fill=white, width=lw)
    # 스탠드 기둥
    stem_top = arc_bot - lw
    stem_bot = stem_top + S * 0.10 * scale
    d.rounded_rectangle([cx - lw / 2, stem_top, cx + lw / 2, stem_bot],
                        radius=lw / 2, fill=white)
    # 받침
    base_w = w * 1.1
    d.rounded_rectangle([cx - base_w / 2, stem_bot, cx + base_w / 2, stem_bot + lw],
                        radius=lw / 2, fill=white)
    return img


def draw_apple(size):
    # iOS는 투명/둥근모서리를 시스템이 처리 → 꽉 찬 사각 배경
    return draw_icon(size, maskable=True).convert("RGB")


if __name__ == "__main__":
    draw_icon(192).save("icon-192.png")
    draw_icon(512).save("icon-512.png")
    draw_icon(512, maskable=True).save("icon-maskable-512.png")
    draw_apple(180).save("apple-touch-icon.png")
    print("아이콘 생성 완료")
