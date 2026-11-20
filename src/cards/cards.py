#!/usr/bin/env python3
# ** coding: utf-8 -*-

from __future__ import annotations

import argparse
import base64
import functools
import io
import re
import sys
import tomllib
import urllib.request
from pathlib import Path
from xml.sax.saxutils import escape, quoteattr

from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

HERE = Path(__file__).resolve().parent
FONT_DIR = HERE / ".fonts"

_GF = "https://raw.githubusercontent.com/google/fonts/main/ofl/"
FONT_URLS = {
    "Outfit.ttf": _GF + "outfit/Outfit%5Bwght%5D.ttf",
    "IBMPlexMono-Regular.ttf": _GF + "ibmplexmono/IBMPlexMono-Regular.ttf",
    "IBMPlexMono-Medium.ttf": _GF + "ibmplexmono/IBMPlexMono-Medium.ttf",
    "ZenKakuGothicNew-Regular.ttf": _GF + "zenkakugothicnew/ZenKakuGothicNew-Regular.ttf",
    "ZenKakuGothicNew-Medium.ttf": _GF + "zenkakugothicnew/ZenKakuGothicNew-Medium.ttf",
    "ZenKakuGothicNew-Bold.ttf": _GF + "zenkakugothicnew/ZenKakuGothicNew-Bold.ttf",
}


def font_file(name: str) -> Path:
    path = FONT_DIR / name
    if not path.exists():
        FONT_DIR.mkdir(exist_ok=True)
        print(f"downloading {name} ...", file=sys.stderr)
        tmp = path.with_suffix(".part")
        urllib.request.urlretrieve(FONT_URLS[name], tmp)
        tmp.replace(path)
    return path


def num(v: float) -> str:
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return "0" if s in ("", "-0") else s


class Face:
    def __init__(self, file: str, wght: int | None = None):
        self.file, self.wght, self._font = file, wght, None

    def _load(self) -> "Face":
        if self._font is None:
            font = TTFont(font_file(self.file))
            if self.wght is not None:
                font = instancer.instantiateVariableFont(font, {"wght": self.wght})
            self._font = font
            self.glyphs = font.getGlyphSet()
            self.cmap = font.getBestCmap()
            self.upm = font["head"].unitsPerEm
            self.hmtx = font["hmtx"]
        return self

    def has(self, ch: str) -> bool:
        return ord(ch) in self._load().cmap

    def advance(self, ch: str, size: float) -> float:
        return self.hmtx[self.cmap[ord(ch)]][0] * size / self.upm

    def draw(self, ch: str, pen, x: float, y: float, size: float) -> None:
        s = size / self.upm
        rec = DecomposingRecordingPen(self.glyphs)
        self.glyphs[self.cmap[ord(ch)]].draw(rec)
        rec.replay(TransformPen(pen, (s, 0, 0, -s, x, y)))


class Style:
    _warned: set[str] = set()

    def __init__(self, primary: Face, fallback: Face):
        self.faces = (primary, fallback)

    def _face(self, ch: str) -> Face | None:
        if not ch.strip():
            return self.faces[0]
        for face in self.faces:
            if face.has(ch):
                return face
        if ch not in Style._warned:
            Style._warned.add(ch)
            print(f"warning: no glyph for {ch!r} (U+{ord(ch):04X}), skipped", file=sys.stderr)
        return None

    def width(self, text: str, size: float) -> float:
        return sum(f.advance(c, size) for c in text if (f := self._face(c)))

    def path(self, text: str, x: float, y: float, size: float, anchor: str = "start") -> str:
        w = self.width(text, size)
        x -= {"start": 0, "middle": w / 2, "end": w}[anchor]
        pen = SVGPathPen(None, ntos=num)
        for c in text:
            if face := self._face(c):
                face.draw(c, pen, x, y, size)
                x += face.advance(c, size)
        return pen.getCommands()


JP = {w: Face(f"ZenKakuGothicNew-{w}.ttf") for w in ("Regular", "Medium", "Bold")}
SANS = Style(Face("Outfit.ttf", 400), JP["Regular"])
SANS_SEMI = Style(Face("Outfit.ttf", 600), JP["Bold"])
SANS_BOLD = Style(Face("Outfit.ttf", 700), JP["Bold"])
MONO = Style(Face("IBMPlexMono-Regular.ttf"), JP["Regular"])
MONO_MED = Style(Face("IBMPlexMono-Medium.ttf"), JP["Medium"])

_CJK = "\u3000-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af"
_CLOSERS = "、。，．・：；？！ー」』）】〉》〕"
_TOKEN = re.compile(rf"[{_CJK}][{_CLOSERS}]*|[^\s{_CJK}]+\s*|\s+")


def wrap(style: Style, text: str, size: float, max_w: float) -> list[str]:
    lines: list[str] = []
    for para in text.split("\n"):
        line = ""
        for tok in _TOKEN.findall(para):
            if line and style.width((line + tok).rstrip(), size) > max_w:
                lines.append(line.rstrip())
                line = tok.lstrip()
            else:
                line += tok
        lines.append(line.rstrip())
    return lines


def fit(style: Style, text: str, size: float, max_w: float) -> str:
    if style.width(text, size) <= max_w:
        return text
    while text and style.width(text + "…", size) > max_w:
        text = text[:-1]
    return text.rstrip() + "…"


THEMES = {
    "light": dict(bg="#ffffff", border="#d1d9e0", text="#1f2328", muted="#59636e",
                  chip="#f6f8fa", chip_border="#d1d9e0"),
    "dark": dict(bg="#151b23", border="#3d444d", text="#f0f6fc", muted="#9198a1",
                 chip="#212830", chip_border="#3d444d"),
}


def pick(value, theme: str):
    return value[theme] if isinstance(value, dict) else value


ICONS = {
    "x": dict(
        d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z",
        tile={"light": "#000000", "dark": "#ffffff"}, ink={"light": "#ffffff", "dark": "#000000"}),
    "discord": dict(
        d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z",
        tile="#5865f2", ink="#ffffff"),
    "telegram": dict(
        d="M23.91 3.79 20.3 20.84c-.25 1.21-.98 1.5-2 .94l-5.5-4.07-2.66 2.57c-.3.3-.55.56-1.1.56-.72 0-.6-.27-.84-.95L6.3 13.7l-5.45-1.7c-1.18-.35-1.19-1.16.26-1.75L22.4 2.04c.97-.43 1.9.24 1.51 1.75Z",
        tile="#26a5e4", ink="#ffffff"),
    "github": dict(
        d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
        tile={"light": "#1f2328", "dark": "#f0f6fc"}, ink={"light": "#ffffff", "dark": "#1f2328"}),
}

GLYPHS = {
    "music": '<path d="M9 18V5l12-2v13" fill="none" stroke="{ink}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
             '<circle cx="6" cy="18" r="3" fill="{ink}"/><circle cx="18" cy="16" r="3" fill="{ink}"/>',
    "game": '<rect x="2" y="6" width="20" height="12" rx="4" fill="none" stroke="{ink}" stroke-width="2"/>'
            '<path d="M6 12h4M8 10v4" stroke="{ink}" stroke-width="2" stroke-linecap="round"/>'
            '<circle cx="15.5" cy="13" r="1.3" fill="{ink}"/><circle cx="18" cy="10.5" r="1.3" fill="{ink}"/>',
    "tv": '<rect x="2" y="7" width="20" height="14" rx="2.5" fill="none" stroke="{ink}" stroke-width="2"/>'
          '<path d="m17 2-5 5-5-5" fill="none" stroke="{ink}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    "book": '<path d="M4 19.5V5a2 2 0 0 1 2-2h14v14H6.5A2.5 2.5 0 0 0 4 19.5Zm0 0A2.5 2.5 0 0 0 6.5 22H20v-5" '
            'fill="none" stroke="{ink}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
}

LANG_COLORS = {
    "C": "#555555", "C#": "#178600", "C++": "#f34b7d", "CSS": "#663399", "Dart": "#00b4ab",
    "Go": "#00add8", "HTML": "#e34c26", "Java": "#b07219", "JavaScript": "#f1e05a",
    "Kotlin": "#a97bff", "Lua": "#000080", "PHP": "#4f5d95", "PowerShell": "#012456",
    "Python": "#3572a5", "Ruby": "#701516", "Rust": "#dea584", "Shell": "#89e051",
    "Swift": "#f05138", "TypeScript": "#3178c6", "Zig": "#ec915c",
}


def icon(name: str, ink: str, x: float, y: float, size: float = 24) -> str:
    tf = f"translate({num(x)} {num(y)})" + (f" scale({num(size / 24)})" if size != 24 else "")
    if name in GLYPHS:
        return f'<g transform="{tf}">{GLYPHS[name].replace("{ink}", ink)}</g>'
    d = ICONS[name]["d"] if name in ICONS else name
    return f'<path transform="{tf}" d="{d}" fill="{ink}"/>'


def arrow(x: float, y: float, color: str, size: float = 10, sw: float = 1.8) -> str:
    return (f'<path d="M{num(x)} {num(y)}L{num(x + size)} {num(y - size)}'
            f'M{num(x + size * .3)} {num(y - size)}H{num(x + size)}V{num(y - size * .3)}" '
            f'fill="none" stroke="{color}" stroke-width="{sw}" stroke-linecap="round" stroke-linejoin="round"/>')


def svg(w: float, h: float, label: str, body: list[str]) -> str:
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{num(w)}" height="{num(h)}" '
            f'viewBox="0 0 {num(w)} {num(h)}" role="img" aria-label={quoteattr(label)}>'
            f'<title>{escape(label)}</title>{"".join(body)}</svg>\n')


def frame(t: dict, w: float, h: float, rx: float, accent=None) -> list[str]:
    rect = f'<rect x=".5" y=".5" width="{num(w - 1)}" height="{num(h - 1)}" rx="{rx}" fill="{t["bg"]}" stroke="{t["border"]}"/>'
    if not accent:
        return [rect]
    a, b = (accent, accent) if isinstance(accent, str) else accent
    return [
        '<defs>'
        f'<linearGradient id="g" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="{a}"/><stop offset="1" stop-color="{b}"/></linearGradient>'
        f'<clipPath id="c"><rect width="{num(w)}" height="{num(h)}" rx="{rx}"/></clipPath>'
        '</defs>',
        rect,
        f'<rect width="{num(w)}" height="4" fill="url(#g)" clip-path="url(#c)"/>',
    ]


def _read(src: str, base: Path) -> bytes:
    if re.match(r"https?://", src):
        req = urllib.request.Request(src, headers={"User-Agent": "readme-cards"})
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read()
    return (base / src).read_bytes()


@functools.lru_cache(maxsize=None)
def image_data_uri(src: str, base: Path, px: int, cover: bool = False) -> str:
    data = _read(src, base)
    if src.lower().split("?")[0].endswith(".svg"):
        return "data:image/svg+xml;base64," + base64.b64encode(data).decode()
    from PIL import Image, ImageOps

    img = Image.open(io.BytesIO(data))
    buf = io.BytesIO()
    if cover:
        ImageOps.fit(img.convert("RGB"), (px, px), Image.LANCZOS).save(buf, "JPEG", quality=88, optimize=True)
        return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    img = img.convert("RGBA")
    if bbox := img.getbbox():
        img = img.crop(bbox)
    img.thumbnail((px, px), Image.LANCZOS)
    img.save(buf, "PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


PAD, LOGO = 32, 112
TITLE, DESC, CHIP = 36, 17.5, 12.5
DESC_LH, CHIP_H, CHIP_GAP = 24, 28, 8


def chip_list(items: list) -> list[dict]:
    chips = []
    for item in items:
        chip = dict(item) if isinstance(item, dict) else {"text": str(item)}
        if "dot" not in chip and chip["text"] in LANG_COLORS:
            chip["dot"] = LANG_COLORS[chip["text"]]
        chips.append(chip)
    return chips


def chip_width(chip: dict) -> float:
    return MONO_MED.width(chip["text"], CHIP) + 24 + (14 if chip.get("dot") else 0)


def layout_chips(chips: list[dict], x0: float, y0: float, right: float):
    placed, cx, cy = [], x0, y0
    for chip in chips:
        cw = chip_width(chip)
        if cx > x0 and cx + cw > right:
            cx, cy = x0, cy + CHIP_H + CHIP_GAP
        placed.append((chip, cx, cy, cw))
        cx += cw + CHIP_GAP
    return placed, cy + CHIP_H


def draw_chips(placed, t: dict) -> list[str]:
    out = []
    for chip, cx, cy, cw in placed:
        out.append(f'<rect x="{num(cx + .5)}" y="{num(cy + .5)}" width="{num(cw - 1)}" height="{CHIP_H - 1}" '
                   f'rx="{CHIP_H / 2 - .5}" fill="{t["chip"]}" stroke="{t["chip_border"]}"/>')
        tx = cx + 12
        if dot := chip.get("dot"):
            out.append(f'<circle cx="{num(tx + 4)}" cy="{num(cy + CHIP_H / 2)}" r="4.5" fill="{dot}"/>')
            tx += 14
        out.append(f'<path d="{MONO_MED.path(chip["text"], tx, cy + 18.5, CHIP)}" fill="{t["text"]}"/>')
    return out


SOC_H = 76
SOC_LABEL, SOC_HANDLE = 12.5, 19


def social_width(card: dict) -> float:
    text = max(MONO.width(card.get("label", ""), SOC_LABEL), SANS_SEMI.width(card["handle"], SOC_HANDLE))
    return 76 + text + 46


def social_card(card: dict, theme: str, width: float) -> str:
    t = THEMES[theme]
    name = card.get("icon", card["id"])
    preset = ICONS.get(name, {})
    tile = pick(card.get("tile", preset.get("tile", t["text"])), theme)
    ink = pick(card.get("ink", preset.get("ink", t["bg"])), theme)
    ts, tx, ty, isz = 48, 14, (SOC_H - 48) / 2, 24
    body = frame(t, width, SOC_H, 16) + [
        f'<rect x="{tx}" y="{num(ty)}" width="{ts}" height="{ts}" rx="13" fill="{tile}"/>',
        icon(name, ink, tx + (ts - isz) / 2, ty + (ts - isz) / 2),
        f'<path d="{MONO.path(card.get("label", ""), 76, 32, SOC_LABEL)}" fill="{t["muted"]}"/>',
        f'<path d="{SANS_SEMI.path(card["handle"], 76, 54, SOC_HANDLE)}" fill="{t["text"]}"/>',
    ]
    if card.get("arrow", True):
        body.append(arrow(width - 30, 43, t["muted"]))
    label = f'{card.get("label", "")}: {card["handle"]}'.lstrip(": ")
    return svg(width, SOC_H, label, body)


def project_card(card: dict, theme: str, base: Path) -> str:
    t = THEMES[theme]
    W = card.get("width", 756)
    has_logo = "logo" in card
    x0 = PAD + LOGO + 28 if has_logo else PAD
    max_w = W - x0 - PAD

    title_y = 74
    lines = wrap(SANS, card.get("description", ""), DESC, max_w) if card.get("description") else []
    last_y = title_y + (34 if lines else 0) + DESC_LH * max(len(lines) - 1, 0)

    chips = []
    if lang := card.get("language"):
        chips.append({"text": lang, "dot": card.get("language_color", LANG_COLORS.get(lang, "#8b949e"))})
    chips += chip_list(card.get("chips", []))
    placed, bottom = layout_chips(chips, x0, last_y + 16, W - PAD)
    if not placed:
        bottom = last_y + 8
    H = max(bottom + PAD, LOGO + 2 * PAD if has_logo else 0)

    body = frame(t, W, H, 18, card.get("accent", ["#0969da", "#8250df"]))
    if has_logo:
        uri = image_data_uri(card["logo"], base, LOGO * 2)
        body.append(f'<image x="{PAD}" y="{num((H - LOGO) / 2)}" width="{LOGO}" height="{LOGO}" href="{uri}"/>')
    body.append(f'<path d="{SANS_BOLD.path(card["name"], x0, title_y, TITLE)}" fill="{t["text"]}"/>')
    if repo := card.get("repo"):
        ax = W - PAD - 14
        body.append(f'<path d="{MONO.path(repo, ax - 8, 50, 13, anchor="end")}" fill="{t["muted"]}"/>')
        body.append(arrow(ax, 49, t["muted"], size=9, sw=1.6))
    for i, line in enumerate(lines):
        body.append(f'<path d="{SANS.path(line, x0, title_y + 34 + i * DESC_LH, DESC)}" fill="{t["muted"]}"/>')
    body += draw_chips(placed, t)

    label = card["name"] + (f': {card["description"]}' if card.get("description") else "")
    return svg(W, H, label.replace("\n", " "), body)


INT_LABEL, INT_PX = 12.5, 28


def interest_x(card: dict) -> float:
    lw = max((MONO.width(g.get("label", ""), INT_LABEL) for g in card.get("groups", [])), default=0)
    return INT_PX + (lw + 28 if lw else 0)


def interest_width(card: dict) -> float:
    if "width" in card:
        return card["width"]
    rows = [chip_list(g.get("items", [])) for g in card.get("groups", [])]
    natural = max((sum(map(chip_width, r)) + CHIP_GAP * (len(r) - 1) for r in rows if r), default=0)
    title = SANS_BOLD.width(card.get("title", ""), 22) + 2 * INT_PX
    return min(756, max(320, round(interest_x(card) + natural + INT_PX + .5), round(title + .5)))


def interest_card(card: dict, theme: str) -> str:
    t = THEMES[theme]
    W = interest_width(card)
    px, py = INT_PX, 24 + (4 if card.get("accent") else 0)
    groups = card.get("groups", [])
    x_items = interest_x(card)

    top, y = [], py
    if title := card.get("title"):
        top.append(f'<path d="{SANS_BOLD.path(title, px, y + 19, 22)}" fill="{t["text"]}"/>')
        y += 22 + 18
    rows = []
    for i, group in enumerate(groups):
        if i:
            top.append(f'<path d="M{px} {num(y + 12.5)}H{num(W - px)}" stroke="{t["border"]}" stroke-dasharray="2 4"/>')
            y += 25
        placed, bottom = layout_chips(chip_list(group.get("items", [])), x_items, y, W - px)
        rows.append((group, y, placed))
        y = bottom
    H = y + py - (4 if card.get("accent") else 0)

    body = frame(t, W, H, 18, card.get("accent")) + top
    for group, ry, placed in rows:
        if label := group.get("label"):
            body.append(f'<path d="{MONO.path(label, px, ry + 18.5, INT_LABEL)}" fill="{t["muted"]}"/>')
        body += draw_chips(placed, t)

    parts = []
    for group in groups:
        items = ", ".join(c["text"] for c in chip_list(group.get("items", [])))
        parts.append(f'{group["label"]}: {items}' if group.get("label") else items)
    label = (f"{title}. " if title else "") + "; ".join(parts)
    return svg(W, H, label, body)


FAV_W, FAV_H, COVER = 372, 96, 64


def favorite_card(card: dict, theme: str, base: Path) -> str:
    t = THEMES[theme]
    W = card.get("width", FAV_W)
    cx, cy = 16, (FAV_H - COVER) / 2
    body = frame(t, W, FAV_H, 16)

    if src := card.get("image"):
        uri = image_data_uri(src, base, COVER * 2, cover=True)
        body += [
            f'<defs><clipPath id="cv"><rect x="{cx}" y="{num(cy)}" width="{COVER}" height="{COVER}" rx="10"/></clipPath></defs>',
            f'<image x="{cx}" y="{num(cy)}" width="{COVER}" height="{COVER}" preserveAspectRatio="xMidYMid slice" '
            f'clip-path="url(#cv)" href="{uri}"/>',
            f'<rect x="{cx + .5}" y="{num(cy + .5)}" width="{COVER - 1}" height="{COVER - 1}" rx="9.5" fill="none" '
            f'stroke="{t["border"]}" stroke-opacity=".6"/>',
        ]
    else:
        if accent := card.get("accent"):
            a, b = (accent, accent) if isinstance(accent, str) else accent
            body += [
                f'<defs><linearGradient id="tg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{a}"/>'
                f'<stop offset="1" stop-color="{b}"/></linearGradient></defs>',
                f'<rect x="{cx}" y="{num(cy)}" width="{COVER}" height="{COVER}" rx="10" fill="url(#tg)"/>',
            ]
            ink = pick(card.get("ink", "#ffffff"), theme)
        else:
            body.append(f'<rect x="{cx + .5}" y="{num(cy + .5)}" width="{COVER - 1}" height="{COVER - 1}" rx="9.5" '
                        f'fill="{t["chip"]}" stroke="{t["chip_border"]}"/>')
            ink = pick(card.get("ink", t["muted"]), theme)
        body.append(icon(card.get("icon", "music"), ink, cx + 18, cy + 18, 28))

    tx = cx + COVER + 16
    max_w = W - tx - (40 if card.get("url") else 20)
    kind, title, sub = card.get("kind", ""), card["title"], card.get("subtitle", "")
    ys = {(1, 1): (31, 55, 76), (0, 1): (0, 45, 67), (1, 0): (38, 62, 0), (0, 0): (0, 55, 0)}[(bool(kind), bool(sub))]
    if kind:
        body.append(f'<path d="{MONO.path(fit(MONO, kind, 12, max_w), tx, ys[0], 12)}" fill="{t["muted"]}"/>')
    body.append(f'<path d="{SANS_SEMI.path(fit(SANS_SEMI, title, 18, max_w), tx, ys[1], 18)}" fill="{t["text"]}"/>')
    if sub:
        body.append(f'<path d="{SANS.path(fit(SANS, sub, 14.5, max_w), tx, ys[2], 14.5)}" fill="{t["muted"]}"/>')
    if card.get("url"):
        body.append(arrow(W - 30, FAV_H / 2 + 5, t["muted"]))

    label = (f"{kind}: " if kind else "") + title + (f" - {sub}" if sub else "")
    return svg(W, FAV_H, label, body)


def snippet(card: dict, url: str, alt: str, width) -> str:
    base = f'{url.rstrip("/")}/{card["id"]}'
    href = card.get("url", "")
    w = width if isinstance(width, str) else num(width)
    pic = (f'<picture><source media="(prefers-color-scheme: dark)" srcset="{base}-dark.svg">'
           f'<img src="{base}-light.svg" alt={quoteattr(alt)} width="{w}"></picture>')
    return f'<a target="_blank" href="{href}">{pic}</a>' if href else pic


def main() -> None:
    ap = argparse.ArgumentParser(description="Generate light/dark SVG cards for a GitHub profile README.")
    ap.add_argument("-c", "--config", type=Path, default=HERE / "cards.toml")
    ap.add_argument("--snippet", action="store_true", help="print README HTML for every card")
    args = ap.parse_args()

    cfg_path = args.config.resolve()
    cfg = tomllib.loads(cfg_path.read_text(encoding="utf-8"))
    base = cfg_path.parent
    out = (base / cfg.get("out", "../../assets/cards")).resolve()
    out.mkdir(parents=True, exist_ok=True)
    url = cfg.get("asset_url", "/assets/cards")
    display = cfg.get("display", {})
    for name, override in cfg.get("theme", {}).items():
        THEMES.setdefault(name, dict(THEMES["light"])).update(override)

    socials = cfg.get("social", [])
    soc_w = max([cfg.get("social_width", 248)] + [social_width(c) for c in socials])
    kinds = {
        "social": (lambda c, th: social_card(c, th, soc_w),
                   lambda c: (f'{c.get("label", "")}: {c["handle"]}', soc_w)),
        "project": (lambda c, th: project_card(c, th, base),
                    lambda c: (c["name"], c.get("width", 756))),
        "interest": (interest_card,
                     lambda c: (c.get("title", "Interests"), interest_width(c))),
        "favorite": (lambda c, th: favorite_card(c, th, base),
                     lambda c: ((f'{c["kind"]}: ' if c.get("kind") else "") + c["title"], c.get("width", FAV_W))),
    }
    cards = [(kind, card) for kind in kinds for card in cfg.get(kind, [])]
    ids = [card["id"] for _, card in cards]
    if dup := {i for i in ids if ids.count(i) > 1}:
        sys.exit(f"duplicate card id: {', '.join(sorted(dup))}")

    snippets: dict[str, list[str]] = {}
    for kind, card in cards:
        render, describe = kinds[kind]
        for theme in THEMES:
            (out / f'{card["id"]}-{theme}.svg').write_text(render(card, theme), encoding="utf-8")
        print(f'{kind:8} {card["id"]}', file=sys.stderr)
        alt, width = describe(card)
        width = card.get("display_width", display.get(kind, width))
        snippets.setdefault(kind, []).append(snippet(card, url, alt, width))
    print(f"wrote {len(ids) * len(THEMES)} files to {out}", file=sys.stderr)
    if args.snippet:
        for kind, lines in snippets.items():
            print(f"<!-- {kind} -->")
            print("\n".join(lines))


if __name__ == "__main__":
    main()
