#!/usr/bin/env python3
"""把要公开发布的项目里所有「真实个人数据 / 密钥」替换成示例值。

为什么要这一步：这个项目接的是真实车辆账号，源码与文档里天然带有
车牌、家庭坐标、飞书应用 ID、高德 key、本地绝对路径。推到 GitHub 之后就
再也收不回来（缓存、fork、归档站），所以必须在推送前统一替换。

用法：
    python3 tools/scrub.py            # 干跑，只报告会改什么
    python3 tools/scrub.py --write    # 真的写盘
    python3 tools/scrub.py --write --root <目录>

规则集中在 RULES，新增规则只需往表里加一行；替换是幂等的（跑两遍结果一致）。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

#  作者域名 / 个人标识 / 住址地名属于隐私，**一律不写在代码里**：
#  真实值放 tools/personal.json（已 gitignore），仓库只留 personal.example.json。
_PERSONAL_PATH = Path(__file__).with_name("personal.json")


def load_personal() -> dict:
    if _PERSONAL_PATH.exists():
        try:
            return json.loads(_PERSONAL_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            print(f"⚠ {_PERSONAL_PATH} 不是合法 JSON，个人规则将被跳过")
    return {}


PERSONAL = load_personal()
_HOME = PERSONAL.get("home_prefix", "/Users/")
_DOMAIN_ROOT = PERSONAL.get("domain_root", "")
_HANDLE = PERSONAL.get("handle", "")
#  住址地名 → 示例地名（顺序：长串在前，避免被短串切碎）
#  长串在前：先替换「XX 小区」全名，再替换里面拆出来的短词，否则会被切碎
_PLACE_RULES = sorted(((name, "示例") for name in PERSONAL.get("places", [])),
                      key=lambda kv: -len(kv[0]))

# (说明, 正则, 替换值)
RULES: list[tuple[str, str, str]] = [
    # 车牌：保留省份与字母，后面换成全 0 的示例号段
    ("车牌号", r"赣(?!A00000)[A-Z][0-9A-Z]{5}", "赣A00000"),
    # 家庭/公司真实坐标，换成通用示例点
    ("纬度", r"\b28\.\d{3,}\b", "30.000000"),
    ("经度", r"\b115\.\d{3,}\b", "120.000000"),
    # 高德 Web 端 JS key / 安全密钥是 32 位十六进制，由 scrub_secrets() 按形状替换
    # 飞书应用 ID（形似 cli_ 开头 18 位）与用户 open_id
    ("飞书 app_id", r"cli_(?!x{8,})[a-z0-9]{16}", "cli_xxxxxxxxxxxxxxxx"),
    ("飞书 open_id", r"ou_[a-f0-9]{32}", "ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"),
    # 车架号（VIN）：理想 L 系真实 VIN 以 HLX 开头；测试夹具也一并处理
    ("VIN", r"HLX[0-9A-Z]{14}", "LTEST000000000001"),
    ("VIN(夹具)", r"LYW11IFNNIFNTTCBL", "LTEST000000000001"),
    # 本地绝对路径：先把项目根换成相对写法，再削掉家目录用户名
    (
        "项目绝对路径",
        _HOME + r"[^/\s]+/(?:[^/\s]+/)*projects/[^/\s]+",
        "~/projects/your-project",
    ),
    ("家目录路径", _HOME + r"[A-Za-z0-9_.-]+", "~"),
    # 手机号（如果有）
    ("手机号", r"\b1[3-9]\d{9}\b", "13800000000"),
]

#  个人隐私类规则只在填了 tools/personal.json 时启用；值为空时整条跳过，
#  否则空 f-string 会退化成「匹配一切」的正则。
if _DOMAIN_ROOT:
    RULES += [
        ("个人域名", rf"\b(?:[a-z0-9-]+\.)?{_DOMAIN_ROOT}\.com\b", "car.example.com"),
        ("个人标识", rf"\b{_DOMAIN_ROOT}\b", "your-name"),
    ]
if _HANDLE:
    RULES += [
        ("个人 workers.dev 子域",
         rf"\b(?:[a-z0-9-]+\.)?{_HANDLE}\.workers\.dev\b", "your-worker.your-name.workers.dev"),
        ("个人标识", rf"\b{_HANDLE}\b", "your-name"),
    ]

TEXT_SUFFIXES = {
    ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx",
    ".json", ".jsonc", ".webmanifest",
    ".md", ".txt", ".sql", ".sh", ".py", ".html", ".css", ".yml", ".yaml", ".toml",
}

SKIP_DIRS = {".git", "node_modules", ".wrangler", "dist", "build", "__pycache__"}


def iter_files(root: Path):
    for p in sorted(root.rglob("*")):
        if not p.is_file():
            continue
        if any(part in SKIP_DIRS for part in p.parts):
            continue
        if p.suffix.lower() not in TEXT_SUFFIXES:
            continue
        # 自己不要替换自己，否则规则字符串会被改写；
        # personal.json 是规则来源（本机私有、已 gitignore），也不动
        if p.name in {"scrub.py", "personal.json"}:
            continue
        yield p


#  高德 key / 安全密钥都是 32 位十六进制。脚本里既不存明文、也不存摘要
#  （摘要也是从密钥派生出来的，没必要留），直接按「形状」识别。
_HEX32 = r"[a-f0-9]{32}"
#  唯一要原样保留的 32 位十六进制：assets/public/car-license.txt 里
#  Sketchfab 模型 UID —— 它是公开署名的一部分，不是密钥。
_HEX32_ALLOW = "c1849ebdf7a54502b249526f88695cc9"
_HEX32_OTHER = re.compile(rf"\b(?!{_HEX32_ALLOW}\b){_HEX32}\b")


def scrub_secrets(text: str) -> tuple[str, list[tuple[str, str, int]]]:
    """把 32 位十六进制形态的密钥换成占位符（按上下文给不同占位符）。"""
    hits: list[tuple[str, str, int]] = []
    text, n = re.subn(
        rf'(securityJsCode\s*:\s*"){_HEX32}(")',
        r"\1YOUR_AMAP_SECURITY_CODE\2", text)
    if n:
        hits.append(("高德安全密钥", "YOUR_AMAP_SECURITY_CODE", n))
    text, n = re.subn(rf"([?&]key=){_HEX32}", r"\1YOUR_AMAP_JS_KEY", text)
    if n:
        hits.append(("高德 JS key", "YOUR_AMAP_JS_KEY", n))
    text, n = _HEX32_OTHER.subn("YOUR_32_HEX_SECRET", text)
    if n:
        hits.append(("32 位十六进制密钥", "YOUR_32_HEX_SECRET", n))
    return text, hits


def scrub_text(text: str) -> tuple[str, list[tuple[str, str, int]]]:
    hits: list[tuple[str, str, int]] = []
    text, secret_hits = scrub_secrets(text)
    hits.extend(secret_hits)
    for name, repl in _PLACE_RULES:
        text, n = re.subn(re.escape(name), repl, text)
        if n:
            hits.append(("住址地名", repl, n))
    for label, pattern, repl in RULES:
        text, n = re.subn(pattern, repl, text)
        if n:
            hits.append((label, repl, n))
    return text, hits


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=None, help="要处理的根目录，默认是本脚本的上上级")
    ap.add_argument("--write", action="store_true", help="真的写盘（默认干跑）")
    args = ap.parse_args()

    root = Path(args.root).resolve() if args.root else Path(__file__).resolve().parent.parent
    total_files = 0
    total_hits = 0
    for path in iter_files(root):
        try:
            original = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        updated, hits = scrub_text(original)
        if not hits:
            continue
        total_files += 1
        rel = path.relative_to(root)
        for label, repl, n in hits:
            total_hits += n
            print(f"{rel}: {label} ×{n} → {repl}")
        if args.write and updated != original:
            path.write_text(updated, encoding="utf-8")

    mode = "已写入" if args.write else "干跑（未写盘，加 --write 生效）"
    print(f"\n{mode}：{total_files} 个文件、{total_hits} 处替换")
    return 0


if __name__ == "__main__":
    sys.exit(main())
