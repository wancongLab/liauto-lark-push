#!/usr/bin/env python3
"""把飞书卡片 JSON 渲染成 HTML —— 用于给 README / 社媒做卡片截图。

为什么需要它：卡片是飞书客户端渲染的，本地没法截真图；但卡片 JSON 里
写明了每个元素的类型、字号、颜色、排版，照着画一遍就能得到可用作展示的图。

用法：
    python3 tools/card_render.py <card.json> -o out.html [--title 备注]

注意：这是**视觉复刻**，不是飞书真实渲染。圆角/字体灰度会有细微差别，
配色以 FEISHU_PALETTE 为准，改这里就能整体校准。
"""
from __future__ import annotations

import argparse
import html
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ICON_DIR = ROOT / "assets" / "icons"

# 飞书卡片标题栏配色：template -> (背景色, 文字色)
# blue 是唯一使用饱和底色的（飞书主色），其余都是浅色调 + 深色字。
FEISHU_PALETTE: dict[str, tuple[str, str]] = {
    "blue": ("#4A7CF7", "#FFFFFF"),
    "wathet": ("#E1EAFF", "#1F2329"),
    "turquoise": ("#DAF2F0", "#1F2329"),
    "green": ("#DFF5E3", "#1F2329"),
    "yellow": ("#FBF1C8", "#1F2329"),
    "orange": ("#FDE8D6", "#1F2329"),
    "red": ("#FCE3E3", "#1F2329"),
    "carmine": ("#FBE2E8", "#1F2329"),
    "violet": ("#EAE3FB", "#1F2329"),
    "purple": ("#EDE1FB", "#1F2329"),
    "indigo": ("#E4E8FA", "#1F2329"),
    "grey": ("#F0F1F2", "#1F2329"),
    "default": ("#F5F6F7", "#1F2329"),
}

TEXT_SIZE = {
    "heading-1": (26, 600),
    "heading-2": (22, 600),
    "heading-3": (18, 600),
    "heading-4": (16, 600),
    "normal": (14, 400),
    "notation": (12, 400),
}

FONT_COLOR = {
    "grey": "#8F959E",
    "gray": "#8F959E",
    "green": "#2EA121",
    "red": "#D83931",
    "orange": "#DE7802",
    "blue": "#3370FF",
    "yellow": "#DBA102",
}

BOLD_MARK = re.compile(r"\*\*(.+?)\*\*", re.S)
FONT_TAG = re.compile(r"<font\s+color=['\"]?([a-z_]+)['\"]?\s*>(.*?)</font>", re.S | re.I)
LINK = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")


def md_html(text: str) -> str:
    """把卡片 markdown 里用到的极少数语法转成 HTML。"""
    #  飞书的 <font color='grey'>…</font> 必须先取出再转义，否则会被 escape 成字面量
    kept: list[str] = []

    def _font(m):
        kept.append(
            f'<span style="color:{FONT_COLOR.get(m.group(1).lower(), "#646A73")}">'
            f'{html.escape(m.group(2))}</span>'
        )
        return f"\x00F{len(kept) - 1}\x00"

    s = FONT_TAG.sub(_font, text)
    s = html.escape(s)
    s = BOLD_MARK.sub(r"<b>\1</b>", s)
    s = LINK.sub(r'<a href="\2">\1</a>', s)
    for i, frag in enumerate(kept):
        s = s.replace(f"\x00F{i}\x00", frag)
    s = s.replace("\n", "<br>")
    return s


def _meta(e: dict) -> dict:
    """字号/对齐/颜色可能写在元素上，也可能写在 text 子对象里（飞书两种都允许）。"""
    t = e.get("text")
    return t if isinstance(t, dict) else e


def size_cls(e: dict, default: tuple[int, int] = (14, 400)) -> str:
    key = _meta(e).get("text_size")
    px, weight = TEXT_SIZE.get(key, default) if isinstance(key, str) else default
    return f"font-size:{px}px;font-weight:{weight}"


def align(e: dict) -> str:
    a = _meta(e).get("text_align")
    return {"center": "center", "right": "right"}.get(a, "left")


def text_color(e: dict) -> str:
    c = _meta(e).get("text_color")
    return FONT_COLOR.get(c, "") if isinstance(c, str) else ""


def icon_path(img_key: str) -> str | None:
    name = ICON_MAP.get(img_key)
    if not name:
        return None
    p = ICON_DIR / f"{name}.png"
    return f"file://{p}" if p.exists() else None


ICON_MAP: dict[str, str] = json.loads((ROOT / "tools" / "icon-map.json").read_text())


EXTRA_IMG: dict[str, str] = {}

#  折叠箭头：飞书用的是 16px 的 chevron 图标，不是字符
CARET_RIGHT = (
    '<svg class="c-caret" width="14" height="14" viewBox="0 0 16 16" fill="none">'
    '<path d="M6 3.5 10.5 8 6 12.5" stroke="#8F959E" stroke-width="1.6" '
    'stroke-linecap="round" stroke-linejoin="round"/></svg>'
)
CARET_DOWN = (
    '<svg class="c-caret" width="14" height="14" viewBox="0 0 16 16" fill="none">'
    '<path d="M3.5 6 8 10.5 12.5 6" stroke="#8F959E" stroke-width="1.6" '
    'stroke-linecap="round" stroke-linejoin="round"/></svg>'
)


def render_img(e: dict) -> str:
    key = e.get("img_key", "")
    #  脱敏占位：真实停车照片不进公开仓库，用 PH_ 前缀换成灰块
    if key.startswith("PH_"):
        label = ((e.get("alt") or {}).get("content") or "照片")
        return f'<div class="c-photo-ph">{html.escape(label)}</div>'
    #  --img 传进来的整图（如行程线路图），按块级图片渲染
    if key in EXTRA_IMG:
        alt = ((e.get("alt") or {}).get("content") or "")
        return (
            f'<img class="c-photo" src="{EXTRA_IMG[key]}" alt="{html.escape(alt)}">'
        )
    src = icon_path(key)
    if not src:
        return ""
    size = e.get("size")
    px = {"tiny": 20, "small": 26, "medium": 40, "large": 64}.get(size, 20)
    return f'<img class="c-icon" src="{src}" width="{px}" height="{px}" alt="">'


def render_markdown(e: dict) -> str:
    return f'<div class="c-md" style="{size_cls(e)};text-align:{align(e)}">{md_html(e.get("content", ""))}</div>'


def render_div(e: dict) -> str:
    parts = []
    if e.get("text"):
        t = e["text"]
        color = text_color(e)
        cs = f";color:{color}" if color else ""
        content = t.get("content", "")
        #  电话号这类「一整串、没空格」的长值在一列里会被折断（400-686-\n0900），
        #  统一压小一号并禁止折行，宁可略窄也不要断成两行。
        tight = ""
        if len(content) >= 9 and re.fullmatch(r"[0-9A-Za-z¥$\-–—./:%,]+", content):
            tight = ";white-space:nowrap;font-size:14.5px;letter-spacing:-.4px"
        parts.append(
            f'<div class="c-md" style="{size_cls(e)};text-align:{align(e)}{cs}{tight}">{md_html(content)}</div>'
        )
    fields = e.get("fields") or []
    if fields:
        short = [f for f in fields if f.get("is_short")]
        long_ = [f for f in fields if not f.get("is_short")]
        if short:
            items = "".join(
                f'<div class="c-field">{md_html(f["text"].get("content", ""))}</div>' for f in short
            )
            parts.append(f'<div class="c-fields">{items}</div>')
        for f in long_:
            parts.append(f'<div class="c-field">{md_html(f["text"].get("content", ""))}</div>')
    return f'<div class="c-div">{"".join(parts)}</div>'


def render_column(e: dict) -> str:
    bg = e.get("background_style") or ""
    cls = "c-col"
    if bg.startswith("grey"):
        cls += " c-col-grey"
    auto = (e.get("width") or "weighted") == "auto"
    flex = "0 0 auto" if auto else f'{e.get("weight") or 1} 1 0'
    pad = e.get("padding") or "0"
    vgap = e.get("vertical_spacing") or "2px"
    valign = e.get("vertical_align") or "center"
    justify = {"center": "center", "top": "flex-start", "bottom": "flex-end"}.get(valign, "center")
    inner = "".join(render_element(x) for x in e.get("elements") or [])
    return (
        f'<div class="{cls}" style="flex:{flex};padding:{pad};gap:{vgap};justify-content:{justify}">{inner}</div>'
    )


def render_column_set(e: dict) -> str:
    mode = e.get("flex_mode") or "none"
    spacing = e.get("horizontal_spacing") or "8px"
    cols = "".join(render_column(c) for c in e.get("columns") or [])
    wrap = "flex-wrap:wrap;" if mode == "flow" else ""
    return f'<div class="c-cs c-cs-{mode}" style="gap:{spacing};{wrap}">{cols}</div>'


def render_panel(e: dict) -> str:
    h = e.get("header") or {}
    title = h.get("title", {}).get("content", "")
    expanded = bool(e.get("expanded"))
    inner = "".join(render_element(x) for x in e.get("elements") or [])
    body = (
        f'<div class="c-panel-body">{inner}</div>'
        if expanded
        else f'<div class="c-panel-body" style="display:none">{inner}</div>'
    )
    caret = CARET_DOWN if expanded else CARET_RIGHT
    radius = ((e.get("border") or {}).get("corner_radius") or "8px")
    return (
        f'<div class="c-panel{" c-panel-open" if expanded else ""}" style="border-radius:{radius}">'
        f'<div class="c-panel-head"><span class="c-caret">{caret}</span>'
        f'<span class="c-md">{md_html(title)}</span></div>{body}</div>'
    )


def render_button(e: dict) -> str:
    text = (e.get("text") or {}).get("content", "")
    kind = e.get("type") or "default"
    return f'<button class="c-btn c-btn-{kind}">{html.escape(text)}</button>'


def _fmt_num(v, fmt: dict) -> str:
    if v is None:
        return "--"
    try:
        prec = int(fmt.get("precision", 0) or 0)
        n = f"{float(v):,.{prec}f}" if fmt.get("separator") else f"{float(v):.{prec}f}"
    except Exception:
        n = str(v)
    sym = fmt.get("symbol") or ""
    return f"{sym}{n}" if sym in ("¥", "$") else f"{n} {sym}".strip()


def render_chart(e: dict) -> str:
    """飞书 chart_spec 的柱状图复刻（vertical bar）。其它类型退化成数值条。"""
    spec = e.get("chart_spec") or {}
    values = ((spec.get("data") or {}).get("values")) or []
    if not values:
        return ""
    xf = spec.get("xField") or "name"
    yf = spec.get("yField") or "value"
    color = (spec.get("color") or ["#4A7CF7"])[0]
    title = ((spec.get("title") or {}).get("text")) or ""
    height = int(str(e.get("height") or "180px").replace("px", ""))
    bars = []
    data = []
    for v in values:
        try:
            data.append((str(v.get(xf, "")), float(v.get(yf, 0) or 0)))
        except Exception:
            data.append((str(v.get(xf, "")), 0.0))
    mx = max([d[1] for d in data] + [1e-9])
    for label, val in data:
        h = max(2, round(val / mx * (height - 46)))
        bars.append(
            f'<div class="c-bar"><div class="c-bar-v">{val:g}</div>'
            f'<div class="c-bar-f" style="height:{h}px;background:{color}"></div>'
            f'<div class="c-bar-x">{html.escape(label)}</div></div>'
        )
    t = f'<div class="c-chart-t">{html.escape(title)}</div>' if title else ""
    return f'<div class="c-chart">{t}<div class="c-bars">{"".join(bars)}</div></div>'


def render_table(e: dict) -> str:
    cols = e.get("columns") or []
    rows = e.get("rows") or []
    hstyle = e.get("header_style") or {}
    head = "".join(
        f'<th style="text-align:{c.get("horizontal_align") or "left"}">{html.escape(c.get("display_name", ""))}</th>'
        for c in cols
    )
    body = []
    for r in rows:
        tds = []
        for c in cols:
            v = r.get(c.get("name"))
            fmt = c.get("format") or {}
            cell = _fmt_num(v, fmt) if c.get("data_type") == "number" else str(v if v is not None else "--")
            tds.append(f'<td style="text-align:{c.get("horizontal_align") or "left"}">{html.escape(cell)}</td>')
        body.append("<tr>" + "".join(tds) + "</tr>")
    return (
        f'<div class="c-table"><table><thead><tr>{head}</tr></thead>'
        f'<tbody>{"".join(body)}</tbody></table></div>'
    )


def render_form(e: dict) -> str:
    name = e.get("name") or ""
    inner = "".join(render_element(x) for x in e.get("elements") or [])
    gap = e.get("vertical_spacing") or "8px"
    return f'<div class="c-form" data-form="{html.escape(name)}" style="gap:{gap}">{inner}</div>'


def render_input(e: dict) -> str:
    ph = ((e.get("placeholder") or {}).get("content")) or ""
    return f'<div class="c-input">{html.escape(ph)}</div>'


def render_element(e: dict) -> str:
    tag = e.get("tag")
    if tag == "markdown":
        return render_markdown(e)
    if tag == "div":
        return render_div(e)
    if tag == "column_set":
        return render_column_set(e)
    if tag == "collapsible_panel":
        return render_panel(e)
    if tag == "img":
        return render_img(e)
    if tag == "button":
        return render_button(e)
    if tag == "hr":
        return '<hr class="c-hr">'
    if tag == "chart":
        return render_chart(e)
    if tag == "table":
        return render_table(e)
    if tag == "form":
        return render_form(e)
    if tag == "input":
        return render_input(e)
    return ""


def render_header(header: dict) -> str:
    tpl = header.get("template") or "default"
    bg, fg = FEISHU_PALETTE.get(tpl, FEISHU_PALETTE["default"])
    title = (header.get("title") or {}).get("content", "")
    sub = (header.get("subtitle") or {}).get("content", "")
    tags = header.get("text_tag_list") or []
    tag_html = ""
    if tags:
        pills = []
        for t in tags:
            color = t.get("color") or "neutral"
            label = (t.get("text") or {}).get("content", "")
            pills.append(f'<span class="c-tag c-tag-{color}">{html.escape(label)}</span>')
        tag_html = f'<span class="c-tags">{"".join(pills)}</span>'
    sub_html = f'<div class="c-sub">{html.escape(sub)}</div>' if sub else ""
    on_solid = tpl == "blue"
    #  标签紧跟主标题（不再右对齐），副标题因此能占满整行，不会被迫换行
    return (
        f'<div class="c-header{" c-header-solid" if on_solid else ""}" style="background:{bg};color:{fg}">'
        f'<div class="c-title"><span class="c-t">{html.escape(title)}</span>{tag_html}</div>'
        f"{sub_html}</div>"
    )


CSS = """
:root{--card:#fff;--fg:#1F2329;--fg2:#646A73;--dim:#8F959E;--line:#DEE0E3;--grey:#F5F6F7;--accent:#4A7CF7}
*{box-sizing:border-box;margin:0;padding:0}
body{background:#E9EAEC;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
     -webkit-font-smoothing:antialiased;padding:24px;display:flex;justify-content:center}
.stage{width:362px}
.card{background:var(--card);border-radius:14px;overflow:hidden;color:var(--fg);
      box-shadow:0 2px 10px rgba(31,35,41,.10)}
.c-header{padding:13px 16px 12px}
.c-title{font-size:17px;font-weight:600;line-height:1.35;letter-spacing:.2px;display:flex;align-items:center;gap:6px;flex-wrap:nowrap}
.c-title .c-t{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.c-sub{font-size:12px;opacity:.62;margin-top:3px;line-height:1.4}
.c-tags{display:inline-flex;gap:4px;flex:none;flex-wrap:nowrap;align-items:center}
.c-header-solid .c-tag{background:rgba(255,255,255,.24);color:#fff}
.c-tag{font-size:11px;padding:2px 7px;border-radius:4px;background:rgba(31,35,41,.08);color:inherit;white-space:nowrap}
.c-tag-green{background:rgba(46,161,33,.16);color:#1b7a14}
.c-tag-blue{background:rgba(51,112,255,.16);color:#2a5bd7}
.c-tag-orange{background:rgba(222,120,2,.16);color:#b86400}
.c-tag-red{background:rgba(216,57,49,.16);color:#b32a22}
.c-tag-yellow{background:rgba(219,161,2,.18);color:#8f6b00}
.c-tag-wathet{background:rgba(51,112,255,.14);color:#2a5bd7}
.c-tag-turquoise{background:rgba(20,150,140,.16);color:#0d7a72}
.c-tag-carmine{background:rgba(214,58,110,.16);color:#b32a58}
.c-tag-violet{background:rgba(120,90,220,.16);color:#5f43b8}
.c-tag-purple{background:rgba(150,80,200,.16);color:#7b3fb0}
.c-tag-indigo{background:rgba(80,100,200,.16);color:#3f4fb0}
.c-tag-grey,.c-tag-neutral{background:rgba(31,35,41,.07);color:#646A73}
.c-body{padding:12px 12px 20px}
.c-md{color:var(--fg);line-height:1.5;word-break:break-word}
.c-md b{font-weight:600}
.c-cs{display:flex;align-items:stretch}
.c-col{min-width:0;display:flex;flex-direction:column;gap:4px;justify-content:center}
.c-col-grey{background:var(--grey);border-radius:8px;padding:10px 6px}
.c-div{display:flex;flex-direction:column;gap:6px}
.c-fields{display:grid;grid-template-columns:1fr 1fr;gap:6px 12px;font-size:12px;color:var(--fg2);line-height:1.5}
.c-field{min-width:0}
.c-panel{border:1px solid var(--line);border-radius:8px;overflow:hidden}
.c-panel-head{display:flex;align-items:center;gap:6px;
  padding:9px 12px;font-size:12px;color:var(--fg2);background:#FAFAFB}
.c-caret{display:inline-flex;align-items:center;flex:0 0 auto;color:var(--dim);font-size:10px}
.c-panel-body{padding:10px 12px;display:flex;flex-direction:column;gap:8px}
.c-btn{font:inherit;font-size:13px;border-radius:6px;padding:6px 12px;border:1px solid var(--line);
  background:#fff;color:var(--fg);cursor:default;white-space:nowrap;line-height:1.3}
.c-btn-primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:500}
.c-btn-default{background:#F2F3F5}
.c-btn-danger{background:#F54A45;border-color:#F54A45;color:#fff}
.c-photo-ph{display:flex;align-items:center;justify-content:center;height:150px;
  background:#EEF0F3;color:#8F959E;font-size:12px;border-radius:8px}
.c-photo{display:block;width:100%;height:auto;border-radius:8px}
.c-icon{display:block;margin:0 auto}
.c-hr{border:0;border-top:1px solid var(--line);margin:2px 0}
.c-chart{padding:2px 0}
.c-chart-t{font-size:12px;color:#8F959E;margin-bottom:6px}
.c-bars{display:flex;align-items:flex-end;gap:5px;height:150px}
.c-bar{flex:1 1 0;min-width:0;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:100%}
.c-bar-v{font-size:10px;color:#8F959E;margin-bottom:2px}
.c-bar-f{border-radius:4px 4px 2px 2px;width:100%;max-width:34px}
.c-bar-x{font-size:9px;color:#646A73;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.c-table{border:1px solid #E4E6E9;border-radius:8px;overflow:hidden}
.c-table table{width:100%;border-collapse:collapse;font-size:12px}
.c-table th{background:#F5F6F7;color:#646A73;font-weight:600;font-size:11px;padding:6px 8px;display:table-cell}
.c-table td{padding:7px 8px;border-top:1px solid #EFF0F1;color:#1F2329}
.c-form{display:flex;flex-direction:column}
.c-input{border:1px solid #DEE0E3;border-radius:6px;padding:7px 10px;font-size:13px;color:#8F959E;background:#fff}
"""


def build(card: dict, note: str = "") -> str:
    body = card.get("body") or {}
    padding = body.get("padding") or "12px 12px 20px"
    spacing = body.get("vertical_spacing") or "12px"
    inner = "".join(render_element(e) for e in body.get("elements") or [])
    return f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>{html.escape(note or "card")}</title><style>{CSS}</style></head>
<body><div class="stage"><div class="card">
{render_header(card.get("header") or {})}
<div class="c-body" style="padding:{padding};display:flex;flex-direction:column;gap:{spacing}">{inner}</div>
</div></div></body></html>"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("card_json")
    ap.add_argument("-o", "--out", required=True)
    ap.add_argument("--title", default="")
    ap.add_argument("--img", action="append", default=[], metavar="KEY=PATH",
                    help="把 img_key 映射到本地图片（行程线路图等）")
    args = ap.parse_args()

    for spec in args.img:
        k, _, v = spec.partition("=")
        EXTRA_IMG[k.strip()] = Path(v.strip()).absolute().as_uri()

    raw = json.loads(Path(args.card_json).read_text())
    card = raw.get("card", raw)
    Path(args.out).write_text(build(card, args.title), encoding="utf-8")
    print(f"HTML → {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
