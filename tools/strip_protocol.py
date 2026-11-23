#!/usr/bin/env python3
"""
把「车辆访问协议层」从代码里摘出去（公开仓库专用）。

背景：真正把车的数据拿下来，需要各家的登录/签名协议。理想这套协议是从 App 二进制里
逆向出来的（登录 PAKE + RSA 签名 + 密钥派生），属于厂商的私有素材，不适合随仓库分发。
所以公开版保留**产品层**（拿到数据之后怎么用：卡片、面板、分享页、推送、去重、告警），
把协议层换成 `app/src/lib/vehicle/` 里的一层接口：

    sample  =  内置模拟数据（默认，跑通全链路，不需要任何账号）
    custom  =  你自己实现（接你自己的车/你自己的接口）

这个脚本是幂等的：跑第二遍不会再改动任何东西。它做四件事：
  1. collector.js  的 import 与 buildClient()   → 改成 createVehicleClient()
  2. collector.js  的 checkCredentialHealth()   → 改成读 provider 的 credentialStatus()
  3. collector.js  删掉 tryAutoRenew / pushRenewFailureAlert（PAKE 重登 + 风控告警）
  4. index.js      删掉协议 import，凭据续期端点改成 501，凭据状态端点改读 provider

用法：python3 tools/strip_protocol.py
"""
import os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COLLECTOR = os.path.join(ROOT, "app/src/lib/collector.js")
INDEX = os.path.join(ROOT, "app/src/index.js")


def find_block(src, signature):
    """从 signature 所在位置向后扫，返回整段（含前置文档注释）的 [start, end)。"""
    i = src.find(signature)
    if i < 0:
        return None
    # 把紧跟其上的 /** ... */ 文档注释一起吃进来
    head = src.rfind("/**", 0, i)
    if head >= 0 and src[src.find("*/", head) + 2: i].strip() == "":
        i = head
    j = src.index("{", src.find(signature))
    depth, k = 0, j
    while k < len(src):
        ch = src[k]
        if ch == "/" and src[k + 1] == "/":
            k = src.find("\n", k)
            continue
        if ch == "/" and src[k + 1] == "*":
            k = src.find("*/", k) + 2
            continue
        if ch in "\"'`":
            q, k = ch, k + 1
            while k < len(src):
                if src[k] == "\\":
                    k += 2
                    continue
                if src[k] == q:
                    break
                k += 1
            k += 1
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return i, k + 1
        k += 1
    raise SystemExit(f"未找到 {signature} 的结束位置")


def replace_fn(path, signature, new_code):
    src = open(path, encoding="utf-8").read()
    blk = find_block(src, signature)
    if blk is None:
        print(f"  · {os.path.basename(path)}: 没有 {signature.split('(')[0]}（已摘过）")
        return
    a, b = blk
    src = src[:a] + new_code.strip() + src[b:]
    open(path, "w", encoding="utf-8").write(src)
    print(f"  · {os.path.basename(path)}: 替换 {signature.split('(')[0]}")


def delete_fn(path, signature):
    src = open(path, encoding="utf-8").read()
    blk = find_block(src, signature)
    if blk is None:
        print(f"  · {os.path.basename(path)}: 没有 {signature.split('(')[0]}（已摘过）")
        return
    a, b = blk
    # 顺手删掉函数后面多出来的空行
    while b < len(src) and src[b] == "\n":
        b += 1
    open(path, "w", encoding="utf-8").write(src[:a] + src[b:])
    print(f"  · {os.path.basename(path)}: 删除 {signature.split('(')[0]}")


def patch_imports(path, drop_lines, add_lines=()):
    lines = open(path, encoding="utf-8").read().split("\n")
    kept = [ln for ln in lines if ln.strip() not in drop_lines]
    if len(kept) != len(lines):
        for ln in add_lines:
            if ln not in kept:
                kept.insert(0, ln)
        open(path, "w", encoding="utf-8").write("\n".join(kept))
        print(f"  · {os.path.basename(path)}: import 已改")
    else:
        print(f"  · {os.path.basename(path)}: import 已改（跳过）")


def patch_test_exports(path, names):
    src = open(path, encoding="utf-8").read()
    for n in names:
        src = src.replace(f"  {n},\n", "")
    open(path, "w", encoding="utf-8").write(src)


BUILD_CLIENT = '''
export async function buildClient(env, D1 = null) {
  //  一句话：把「怎么拿到数据」交给 vehicle provider（示例实现见 app/src/lib/vehicle/）。
  //  公开版只带 sample 实现；接你自己的车时实现 vehicle/custom.js。
  return createVehicleClient(env, D1);
}
'''

CHECK_CRED = '''
/**
 * 凭据健康检查（面板「凭据」徽标 / 凭据告警卡的数据源）。
 *
 *  公开版不碰任何登录协议，所以这里只做一件事：问 provider「现在什么状态」。
 *  示例实现恒返回 level="sample"（不告警）；接自己的车时由你的 provider 返回
 *  ok / warning / critical / dead（干的活和原来一样：落 state + 落健康表 + 临期告警）。
 */
export async function checkCredentialHealth(env, D1, vin, results, log, client = null) {
  const c = client || (await buildClient(env, D1));
  const status = c?.credentialStatus?.() || { level: "unknown", warnings: [] };
  results.credentials = {
    level: status.level,
    days_left: status.days_left ?? null,
    expires_at: status.expires_at ?? null,
    expiry_source: status.expiry_source ?? null,
  };
  await db.setState(D1, "creds:status", status);
  await db.healthUpsert(
    D1, vin, "creds",
    status.level !== "dead",
    (status.warnings || []).join("; ") || null,
  );
  if (status.level === "ok" || status.level === "sample") return status;

  const target = await db.getState(D1, "feishu:target");
  if (!target) {
    log("凭据有问题，但还没绑定飞书推送目标，跳过告警");
    return status;
  }
  const eventKey = `cred:alert:${status.level}:${shanghaiDate()}`;
  const first = await db.markPushed(D1, vin, eventKey, "feishu", { level: status.level });
  if (!first) return status;

  const card = cards.buildCredCard({
    level: status.level,
    daysLeft: status.days_left ?? null,
    expiresText: status.expires_at ?? null,
    items: status.items || [],
  });
  const res = await sendCard(env, target, card);
  if (res.ok) results.pushed.push({ key: eventKey, ok: true });
  else results.errors.push(`cred-alert: ${res.msg}`);
  return status;
}
'''

CRED_ROTATE = '''
async function apiCredRotate(request, env) {
  //  开源版说明：这个端点原本是「在 Worker 里重新登录、换一张新令牌」，
  //  依赖从理想 App 逆向出来的登录/签名协议，因此**不在本仓库内**
  //  （见 docs/如何接入你自己的车辆数据.md）。
  //  示例模式本来就不需要续期；接自己的车时，在 vehicle/custom.js 里实现续期后在这里调用。
  return json({
    ok: false,
    unsupported: true,
    provider: env.VEHICLE_PROVIDER || "sample",
    message: "本仓库不含理想 App 的登录协议。示例模式无需续期；接入自己的车辆数据时请在 app/src/lib/vehicle/custom.js 中实现。",
  }, 501);
}
'''

CRED_STATUS = '''
async function apiCredStatus(env) {
  const D1 = env.DB;
  //  凭据状态的唯一来源 = 当前 vehicle provider（示例模式恒为 sample）
  const client = await buildClient(env, D1).catch(() => null);
  const live = client?.credentialStatus?.() || { level: "unknown" };
  const cached = await db.getState(D1, "creds:status");
  return json({
    live,
    provider: client?.provider || (env.VEHICLE_PROVIDER || "sample"),
    last_check: cached || null,
    server_time: shanghaiNow(),
  });
}
'''


def main():
    print("摘除协议层…")
    patch_imports(COLLECTOR,
                  drop_lines={
                      'import { IdealClient } from "./ideal.js";',
                      'import { loadLiveCreds, saveLiveCreds, normalizeCreds, canAttemptRenew, markAttempt } from "./credstore.js";',
                      'import { loadLiveCreds, saveLiveCreds, canAttemptRenew, markAttempt } from "./credstore.js";',
                      'import { credentialStatus, credentialAlertItems } from "./creds.js";',
                      'import { credentialStatus, credentialAlertItems, normalizeCreds } from "./creds.js";',
                      'import { loginWithPassword, LoginError } from "./login.js";',
                      'import { loginWithPassword } from "./login.js";',
                      'import { deriveIdentity } from "./keysuite.js";',
                  },
                  add_lines=('import { createVehicleClient } from "./vehicle/index.js";',))
    replace_fn(COLLECTOR, "export async function buildClient(env, D1 = null)", BUILD_CLIENT)
    replace_fn(COLLECTOR, "export async function checkCredentialHealth(", CHECK_CRED)
    delete_fn(COLLECTOR, "async function tryAutoRenew(")
    delete_fn(COLLECTOR, "async function pushRenewFailureAlert(")
    patch_test_exports(COLLECTOR, ["tryAutoRenew", "pushRenewFailureAlert"])

    patch_imports(INDEX,
                  drop_lines={
                      'import { credentialStatus } from "./lib/creds.js";',
                      'import { loadLiveCreds } from "./lib/credstore.js";',
                      'import { IdealClient } from "./lib/ideal.js";',
                  })
    replace_fn(INDEX, "async function apiCredRotate(", CRED_ROTATE)
    replace_fn(INDEX, "async function apiCredStatus(", CRED_STATUS)
    print("完成。接着跑 tools/scrub.py 与 tools/check_clean.py。")


if __name__ == "__main__":
    main()
