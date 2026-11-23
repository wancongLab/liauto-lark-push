#!/usr/bin/env python3
"""把 screenshots/cards/ 里的卡片图按用途分组，生成总览页 index.html 与 manifest.json。

用法：python3 tools/gallery.py
读：screenshots/cards/*.png
写：screenshots/cards/index.html、screenshots/cards/manifest.json
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "screenshots" / "cards"

# 一张卡只归一个栏目；顺序即页面顺序
GROUPS = [
    ("状态与查询", "打开面板第一眼要知道的：车在哪、还有多少电、下次保养、附近油价", [
        "01-vehicle-status", "02-battery", "12-where", "13-maintenance-query", "17-fuel-price", "18-support",
    ]),
    ("用车报告", "按日 / 周 / 月自动汇总，含里程、电耗、花费与柱状图", [
        "03-today", "04-daily-summary", "05-week-now", "06-week-last", "07-month-now", "08-month-last", "09-energy",
    ]),
    ("充电与补能", "充电全程 + 账单 + 电价，加油卡可以直接在卡里输单价", [
        "10-charge-state", "14-charge-bills", "15-charge-history", "16-charge-price",
        "21-charge-start", "22-charge-done", "26-refuel",
    ]),
    ("行程与停车", "每趟行程会自动生成小结与线路图；回到家或在外停车都会推停车照片", [
        "11-trip", "23-parked-home", "24-parked-out", "25-departure", "27-parking-drain",
    ]),
    ("提醒与告警", "只在需要你注意的时候才响，不是天天推", [
        "28-vehicle-anomaly", "29-charge-aborted", "30-charge-price-push", "31-energy-low",
        "32-cred-warning", "33-ota-upgraded", "34-maintenance-push",
    ]),
    ("指令与设置", "发一句话就能查，推送开关 11 项都能在卡里点", [
        "19-command-menu", "20-push-switches",
    ]),
]

TITLES = {
    "01-vehicle-status": "车辆状态", "02-battery": "电量续航", "03-today": "今日小结",
    "04-daily-summary": "昨日用车小结", "05-week-now": "本周用车小结", "06-week-last": "上周用车小结",
    "07-month-now": "本月用车小结", "08-month-last": "上月用车小结", "09-energy": "能耗小结",
    "10-charge-state": "充电情况", "11-trip": "行程小结", "12-where": "车辆位置",
    "13-maintenance-query": "保养剩余", "14-charge-bills": "充电账单", "15-charge-history": "最近充电",
    "16-charge-price": "当前电价", "17-fuel-price": "油价", "18-support": "帮助与客服",
    "19-command-menu": "指令菜单", "20-push-switches": "推送开关", "21-charge-start": "开始充电",
    "22-charge-done": "充电完成", "23-parked-home": "到家了（停车照片）",
    "24-parked-out": "车辆已停好（在外停车）", "25-departure": "离开家了", "26-refuel": "加油已完成",
    "27-parking-drain": "停车掉电", "28-vehicle-anomaly": "车辆异常",
    "29-charge-aborted": "充电提前结束", "30-charge-price-push": "建议及时充电",
    "31-energy-low": "能量不足提醒", "32-cred-warning": "授权即将过期", "33-ota-upgraded": "车辆已升级",
    "34-maintenance-push": "保养提醒",
}


def main() -> None:
    have = {p.stem for p in ROOT.glob("*.png")}
    manifest, sections = [], []
    for gi, (name, desc, keys) in enumerate(GROUPS, 1):
        items = [k for k in keys if k in have]
        for k in items:
            manifest.append({"file": f"{k}.png", "title": TITLES.get(k, k), "group": name})
        figures = "\n".join(
            f'<figure><img src="{k}.png" alt="{TITLES.get(k, k)}" loading="lazy">'
            f'<figcaption><b>{TITLES.get(k, k)}</b><span>{k}</span></figcaption></figure>'
            for k in items
        )
        sections.append(
            f'<section><div class="sec-h"><h2><i>{gi:02d}</i>{name}</h2>'
            f'<p>{desc}</p><em>{len(items)} 张</em></div>'
            f'<div class="grid">{figures}</div></section>'
        )

    missing = sorted(have - {m["file"][:-4] for m in manifest})
    if missing:
        print("未归类：", ", ".join(missing))

    html = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>liauto-lark-push · 卡片总览</title>
<style>
 :root{{--bg:#0E1116;--card:#151A21;--line:#212934;--fg:#E8EEF5;--fg2:#C9D3DF;--dim:#7E8B9B}}
 *{{box-sizing:border-box}}
 body{{margin:0;background:var(--bg);color:var(--fg2);
   font:14px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
   -webkit-font-smoothing:antialiased}}
 header{{padding:34px 40px 26px;border-bottom:1px solid var(--line)}}
 header h1{{margin:0 0 6px;font-size:22px;color:var(--fg);letter-spacing:.2px}}
 header p{{margin:0;color:var(--dim);font-size:13px}}
 header .tags{{margin-top:14px;display:flex;gap:8px;flex-wrap:wrap}}
 header .tags span{{font-size:12px;color:#8FA0B4;border:1px solid var(--line);
   border-radius:999px;padding:3px 10px}}
 main{{padding:0 40px 72px}}
 section{{margin-top:54px}}
 section+section{{border-top:1px solid var(--line);padding-top:46px}}
 .sec-h{{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-bottom:22px}}
 .sec-h h2{{margin:0;font-size:16px;color:var(--fg);font-weight:650;display:flex;
   align-items:baseline;gap:9px;letter-spacing:.2px}}
 .sec-h h2 i{{font-style:normal;font-size:12px;color:#4A7CF7;font-family:ui-monospace,monospace}}
 .sec-h p{{margin:0;font-size:12.5px;color:var(--dim);flex:1;min-width:200px}}
 .sec-h em{{font-style:normal;font-size:12px;color:#5C6979}}
 .grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(292px,1fr));gap:22px;align-items:start}}
 figure{{margin:0;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px}}
 figure img{{width:100%;display:block;border-radius:9px}}
 figcaption{{margin-top:10px;display:flex;justify-content:space-between;gap:8px;font-size:12px;color:#8FA0B4}}
 figcaption b{{color:var(--fg);font-weight:600}}
 figcaption span{{color:#5C6979;font-family:ui-monospace,monospace;font-size:11px}}
</style></head><body>
<header>
 <h1>飞书卡片 · {len(manifest)} 张</h1>
 <p>全部由线上真实卡片 JSON 渲染（dry_run 取结构，不发送），图标为自绘 PNG，行程线路图为高德底图实拍。</p>
 <div class="tags"><span>6 个栏目</span><span>21 张卡 + 11 个变体</span>
 <span>停车照片已脱敏占位</span><span>「更多信息」全部展开</span></div>
</header>
<main>
{chr(10).join(sections)}
</main></body></html>"""
    (ROOT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1))
    (ROOT / "index.html").write_text(html)
    print(f"index.html + manifest.json 已生成：{len(manifest)} 张 / {len(GROUPS)} 栏")


if __name__ == "__main__":
    main()
