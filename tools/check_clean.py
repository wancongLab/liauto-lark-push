#!/usr/bin/env python3
"""推送前自检：仓库里不允许出现真实个人数据或任何密钥。

和 scrub.py 的分工：scrub 负责改，check 负责验。
check 是硬闸门 —— 命中任何一条就非零退出，用来拦住「以为改干净了其实没有」。

分两级：
  HARD  会让脚本失败：车牌、真实坐标、VIN、飞书 ID、已知密钥、私钥、本地路径、常见 token 前缀
  WARN  只提示：32 位十六进制串（本项目里 keysuite 的加密测试向量也是这个形状，
        所以不能一律判死；人工确认后再放行）

用法：
    python3 tools/check_clean.py
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

#  不把密钥明文写在检查脚本里（否则脚本本身又是一份泄漏）。
#  按形状识别：32 位十六进制串默认当成密钥（脚本里不存明文也不存摘要）。
#  作者域名 / 个人标识 / 住址地名同样属于隐私 —— 真实值只在 tools/personal.json
#  （已 gitignore），仓库里留 personal.example.json 供别人填自己的。
_PERSONAL_PATH = Path(__file__).with_name("personal.json")


def _load_personal() -> dict:
    if not _PERSONAL_PATH.exists():
        return {}
    try:
        return json.loads(_PERSONAL_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


_PERSONAL = _load_personal()
_DOMAIN_ROOT = _PERSONAL.get("domain_root", "")
_HANDLE = _PERSONAL.get("handle", "")
_PLACES = _PERSONAL.get("places", [])

#  高德 key / 安全密钥都是 32 位十六进制。这里不看摘要（摘要也是派生自密钥），
#  直接查形状；唯一放行的是 assets/public/car-license.txt 里的 Sketchfab 模型 UID。
_HEX32_ALLOW = "c1849ebdf7a54502b249526f88695cc9"

HARD: list[tuple[str, str]] = [
    ("真实车牌", r"赣[A-Z](?!00000)[0-9A-Z]{5}"),
    ("真实坐标（作者所在城市一带）", r"\b2[89]\.\d{3,}\b"),
    ("真实坐标（作者所在城市一带）", r"\b11[5-6]\.\d{3,}\b"),
    ("车架号 VIN", r"HLX[0-9A-Z]{14}"),
    # 占位符（cli_xxxx…）不是密钥，用负向断言排除，避免文档示例被误报
    ("飞书 app_id", r"cli_(?!x{8,})[a-z0-9]{16}"),
    ("飞书 open_id", r"ou_[a-f0-9]{32}"),
    ("疑似 API key / token 前缀", r"\b(sk-|ghp_|gho_|xoxb-|xoxp-|AKIA)[A-Za-z0-9_-]{8,}"),
    ("私钥块", r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    ("Bearer 令牌", r"Bearer\s+[A-Za-z0-9._-]{20,}"),
    ("本地绝对路径", r"/Users/[A-Za-z0-9_.-]+"),
    #  32 位十六进制几乎只会是 API key（高德 JS key / 安全密钥都长这样）
    ("32 位十六进制密钥", rf"\b(?!{_HEX32_ALLOW}\b)[a-f0-9]{{32}}\b"),
]

#  个人隐私类规则只在填了 tools/personal.json 时启用（别人的仓库里没有这些值）；
#  值为空时必须整条跳过，否则空 f-string 会退化成「匹配一切」的正则。
if _DOMAIN_ROOT:
    HARD += [
        ("作者的真实域名", rf"\b[a-z0-9-]+\.{_DOMAIN_ROOT}\.com"),
        ("作者的真实域名", rf"\b{_DOMAIN_ROOT}\b"),
    ]
if _HANDLE:
    HARD.append(("个人标识", rf"\b{_HANDLE}\b"))
if _PLACES:
    HARD.append(("与住址绑定的真实地名", "|".join(re.escape(p) for p in _PLACES)))

ADVISORY: list[tuple[str, str]] = [
    ("32 位十六进制（可能是密钥，也可能是加密测试向量）",
     rf"\b(?!{_HEX32_ALLOW}\b)[a-f0-9]{{32}}\b"),
]

# 这些文件/目录绝不该出现在仓库里
FORBIDDEN_PATHS = [
    ".api_token",
    "credentials.json",
    "secrets.local.json",
    ".device_id",
    "pkce.json",
    ".dev.vars",
    "node_modules",
    ".wrangler",
]

TEXT_SUFFIXES = {
    ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx",
    ".json", ".jsonc", ".webmanifest",
    ".md", ".txt", ".sql", ".sh", ".py", ".html", ".css", ".yml", ".yaml", ".toml",
}

# 注意：这里不再跳过 self 与 scrub.py。两个脚本里的真实串都已拆写或换成摘要，
# 它们必须和普通代码一样被扫描——否则「工具自己藏着密钥」这种泄漏永远查不出来（D-14 教训）。
#  personal.json 是本机私有配置（真实域名/地名，已被 .gitignore 覆盖），
#  它天然包含规则要找的那些值，不能在扫描里出现。
# 这三类不是对外文件：package-lock 里是 npm 的完整性哈希；NOTICE.md 是署名；
# PUBLISH.md / HANDOFF-*.md 是给「上传会话」「社媒会话」的内部交接单（都在 .gitignore 里，不随仓库发布），
# 它们必须写绝对路径，否则在新的工作区分组里找不到目录。
SKIP_FILES = {"package-lock.json", "NOTICE.md", "personal.json", "PUBLISH.md"}
SKIP_DIRS = {".git", "node_modules", ".wrangler", "dist", "build", "__pycache__"}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=None)
    args = ap.parse_args()
    root = Path(args.root).resolve() if args.root else Path(__file__).resolve().parent.parent

    #  这些名字本身就不该出现在仓库里。但本地跑 `npm install` / `wrangler dev` 之后
    #  必然会有 node_modules / .wrangler / .dev.vars —— 只要 .gitignore 挡住了就不算问题。
    ignored = ""
    gi = root / ".gitignore"
    if gi.exists():
        ignored = gi.read_text(encoding="utf-8", errors="ignore")
    bad_paths = [
        name for name in FORBIDDEN_PATHS
        if list(root.rglob(f"*{name}"))[:1] and (name not in ignored)
    ]
    hard: list[tuple[Path, int, str, str]] = []
    warn: list[tuple[Path, int, str, str]] = []

    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        if path.name.startswith("HANDOFF-"):
            continue
        if any(part in SKIP_DIRS for part in path.parts) or path.name in SKIP_FILES:
            continue
        if path.suffix.lower() not in TEXT_SUFFIXES:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        for lineno, line in enumerate(text.splitlines(), 1):
            for label, pattern in HARD:
                m = re.search(pattern, line)
                if m:
                    hard.append((path.relative_to(root), lineno, label, m.group(0)[:40]))
            for label, pattern in ADVISORY:
                m = re.search(pattern, line)
                if m:
                    warn.append((path.relative_to(root), lineno, label, m.group(0)[:40]))

    if bad_paths:
        print("✗ 仓库里存在不该提交的敏感文件：")
        for name in bad_paths:
            print(f"    {name}")
        print()

    if warn:
        print(f"· {len(warn)} 处 32 位十六进制串（需人工确认是否只是测试向量）：")
        for rel, lineno, _, sample in warn[:10]:
            print(f"    {rel}:{lineno}  {sample}")
        if len(warn) > 10:
            print(f"    …… 另外 {len(warn) - 10} 处")
        print()

    if hard or bad_paths:
        print(f"✗ 发现 {len(hard)} 处不该出现的真实数据：\n")
        for rel, lineno, label, sample in hard:
            print(f"  {rel}:{lineno}  [{label}]  {sample}")
        print("\n先跑 tools/scrub.py --write，再跑本脚本；仍命中则手工处理。")
        return 1

    print("✓ 干净：没有车牌 / 真实坐标 / VIN / 应用 ID / 密钥 / 本地路径 / 敏感文件。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
