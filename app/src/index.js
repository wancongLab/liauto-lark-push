/**
 * liauto-lark-push · Worker 入口
 *
 * 路由
 * ----
 *   GET  /                    → Web 面板（静态资源）
 *   GET  /api/status          → 车辆实时状态
 *   GET  /api/daily?days=N    → 近 N 天日汇总
 *   GET  /api/month           → 本月汇总 + 逐日曲线
 *   GET  /api/charge          → 充电会话
 *   GET  /api/health          → 采集健康
 *   GET  /api/trip            → 车机行程表（智驾里程等）
 *   POST /api/collect         → 手动触发一次采集（用于验收）
 *   GET  /api/card/status     → 预览「车辆状态速览」飞书卡片 JSON
 *   POST /api/price           → 设置默认电价 / 油价
 *   cron 每分钟               → 采集 + 推送
 *
 * 鉴权：除静态资源与 /api/card/status 外，均需 `li_token` cookie
 *      （登录页输入 API_TOKEN 后写入；仅个人自用，故用轻量方案）
 */

import * as db from "./lib/db.js";
import * as cards from "./lib/cards.js";
import { sendCard, sendText, resolveTarget, verifyChallenge, getTenantToken, discoverChat, verifySignature, decryptEvent, uploadImage } from "./lib/feishu.js";
import { collect, buildClient, parseTripTotal, summarizeRows, highlightsRows, __test as collectorTest } from "./lib/collector.js";
import { sampleReminderCard } from "./lib/reminders.js";
import { haversineM, clusterSummary } from "./lib/geo.js";
import { handleTripShare } from "./lib/tripPage.js";
import { handleTextCommand, handleBotMenu, handleCardAction, planCardAction, runCardAction, recordFuelPriceFromText, MENU_GROUPS, MENU_BUTTONS, __test as commandsTest } from "./lib/commands.js";
import { getSwitches, setSwitch, SWITCH_KINDS, SWITCH_LABELS } from "./lib/pushswitch.js";
import { aggregate as energyAggregate } from "./lib/energy.js";
import { shanghaiNow, shanghaiDate, round, num, safeJson } from "./lib/util.js";
import { lastWeekRange, lastMonthRange, monthRangeOf, monthBefore, nextRuns } from "./lib/schedule.mjs";
import { F, pick, pickJson, num as Fnum, isCharging, chargeStatusText, travelStatusText, buildDetail } from "./lib/fields.js";
import { VSS_PATHS } from "./lib/vss-paths.js";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function hasToken(request, env) {
  const expected = env.API_TOKEN;
  if (!expected) return true;               // 未配置则不鉴权（本地调试用）
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(/(?:^|;\s*)li_token=([^;]+)/);
  if (m && m[1] === expected) return true;
  const url = new URL(request.url);
  if (url.searchParams.get("k") === expected) return true;
  const hdr = request.headers.get("X-API-Token");
  return hdr === expected;
}

async function requireAuth(request, env) {
  if (hasToken(request, env)) return null;
  return json({ error: "unauthorized", hint: "先访问 /login?k=<API_TOKEN>" }, 401);
}

async function serveAsset(request, env, pathname) {
  if (env.ASSETS) return env.ASSETS.fetch(request);
  return new Response("assets not configured", { status: 404 });
}

// D-194（审计 §3.5.1）：静态资源原来全是 max-age=0, must-revalidate，连 27 KB 海报、图标
// 每次打开都要条件请求一遍。按类型分级：
//   图片（图标/海报）7 天 —— 内容基本不随部署变化，省掉每次的条件请求；
//   manifest 1 天；
//   HTML / JS 仍 must-revalidate —— 保证部署后立刻拿到新版（ETag 命中时 304 只有几百字节）。
// 没走「文件名加 hash + immutable」是因为 index.html 也是静态资源、Worker 不重写它，
// 哈希得每次部署手改，忘一次就是线上跑旧 JS，代价比省下的几个 304 大得多。
const IMG_PATH_RE = /\.(png|webp|jpe?g|svg|ico)$/i;
async function serveStatic(request, env, pathname) {
  // 浏览器总会额外要一次 /favicon.ico（审计 P2-14 实测 404），直接回 192 图标
  if (pathname === "/favicon.ico") {
    const r = await serveAsset(new Request(new URL("/icon-192.png", request.url).toString()), env, "/icon-192.png");
    if (r.ok) {
      const h = new Headers();
      h.set("Content-Type", "image/png");
      h.set("Cache-Control", "public, max-age=604800");
      return new Response(r.body, { status: 200, headers: h });
    }
    return new Response(null, { status: 204 });
  }
  const r = await serveAsset(request, env, pathname);
  if (r.status === 304 || r.status === 204) {
    const h = new Headers(r.headers);
    if (pathname === "/manifest.webmanifest") h.set("Cache-Control", "public, max-age=86400");
    else if (IMG_PATH_RE.test(pathname)) h.set("Cache-Control", "public, max-age=604800");
    return new Response(null, { status: r.status, headers: h });
  }
  const h = new Headers(r.headers);
  if (pathname === "/manifest.webmanifest") h.set("Cache-Control", "public, max-age=86400");
  else if (IMG_PATH_RE.test(pathname)) h.set("Cache-Control", "public, max-age=604800");
  else h.set("Cache-Control", "public, max-age=0, must-revalidate");
  return new Response(r.body, { status: r.status, headers: h });
}


/** 从 VSS 原始帧提取可展示的细节（路径见 fields.js，全部实测验证） */


/**
 * 飞书事件回调。
 *  · url_verification → 回 challenge（飞书后台保存请求地址时的验证）
 *  · im.message.receive_v1 → 捕获发送者的 open_id → 自动绑定推送目标
 */
async function feishuWebhook(request, env, ctx) {
  let body = null;
  let raw = "";
  try { raw = await request.text(); body = JSON.parse(raw); } catch { /* ignore */ }
  const D1 = env.DB;

  //  每次命中都落一条日志 —— 用来判断「飞书到底有没有把事件发过来」
  const eventType = body?.header?.event_type || body?.event_type || null;
  const encrypted = Boolean(body?.encrypt);
  //  只接受【当前配置的应用】的事件 ——
  //   open_id 是按应用隔离的，旧应用推来的事件绑定出来会发不到新应用。
  const srcAppId = body?.header?.app_id || body?.app_id || null;
  const myAppId = env.FEISHU_APP_ID || null;
  const foreign = Boolean(srcAppId && myAppId && srcAppId !== myAppId);
  //  日志写入不阻塞回调响应（D-086 修复 200341）：飞书只给 3 秒，
  //   而这次 D1 INSERT 要 ~300 ms。写成 promise，卡片回调路径完全不等它。
  let logPromise = null;
  try {
    logPromise = D1.prepare(`
      INSERT INTO feishu_webhook_log (received_at, type, event_type, has_encrypt, preview, processed)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      shanghaiNow(), body?.type ?? null, eventType, encrypted ? 1 : 0,
      String(raw || "").slice(0, 300),
      foreign ? `ignored:foreign_app:${srcAppId}` : "received",
    ).run().catch(() => null);
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(logPromise);
  } catch { /* 忽略日志失败 */ }

  //  签名校验（若配置了 FEISHU_ENCRYPT_KEY）
  const sigRes = verifySignature(request.headers, raw, env.FEISHU_ENCRYPT_KEY);
  if (!sigRes.ok) {
    console.error("[feishu] 签名校验失败:", sigRes.error);
    return new Response("{}", { status: 200, headers: JSON_HEADERS });
  }

  //  加密事件（若配置了 FEISHU_ENCRYPT_KEY）
  if (encrypted && env.FEISHU_ENCRYPT_KEY) {
    try {
      body = decryptEvent(body.encrypt, env.FEISHU_ENCRYPT_KEY);
    } catch (err) {
      console.error("[feishu] 解密事件失败:", err?.message);
      return new Response("{}", { status: 200, headers: JSON_HEADERS });
    }
  }

  const challenge = verifyChallenge(body);
  if (challenge) return challenge;
  if (encrypted) {
    console.error("[feishu] 收到加密事件但未配置 FEISHU_ENCRYPT_KEY，无法解密");
    return new Response("{}", { status: 200, headers: JSON_HEADERS });
  }
  const ev = body?.event || {};
  try {
    if (body?.type === "event_callback" || body?.header?.event_type) {
      const type = body?.header?.event_type || body?.event_type;
      if (foreign) {
        console.warn("[feishu] 忽略非本应用的事件:", srcAppId);
      } else if (type === "im.message.receive_v1") {
        const openId = ev?.sender?.sender_id?.open_id || ev?.sender?.sender_id?.user_id;
        const chatId = ev?.message?.chat_id || null;
        if (openId) {
          const owner = await db.getState(D1, "feishu:target");
          // 首次发消息 → 绑定推送目标（保留原行为）
          if (!owner || !owner.id) {
            await db.setState(D1, "feishu:target", { type: "open_id", id: openId, at: shanghaiNow() });
            await sendText(env, { type: "open_id", id: openId },
              "已绑定推送目标。用车数据会推送到这里。\n\n发「菜单」看看能用哪些指令。");
          } else if (openId !== owner.id) {
            //  D-086：只有本人能下指令/改配置，其他人静默忽略（防止别人套取车辆位置）
            console.warn("[feishu] 忽略非车主消息:", openId);
          } else {
            const text = feishuText(ev?.message);
            //  D-068：先判断是不是「回复油价」——加油卡会问一句 95# 单价，
            //   用户回一个数字即记价。识别不了才走指令路由。
            const recorded = text ? await recordFuelPriceFromText(env, openId, text) : false;
            if (!recorded) {
              const r = await handleTextCommand(env, { text, chatId });
              if (!r.handled) {
                //  D-178：认不出的输入只提醒一次。打错字是常事，如果每条都回「没认出」，
                //   聊天窗口会被自己的提示刷屏。30 分钟静默期内只记日志、不再回复；
                //   想不起指令时发「菜单」随时能拉出完整指令表。
                //  D-178/D-180：认不出的输入**一天只提醒一次**。
                //   用户原话：「如果你无法识别指令，你只要提醒一次就可以了」——
                //   30 分钟的静默期不够（跨过 30 分钟又会被提醒一次，实测 22:33 / 23:07 各弹一次）。
                //   提醒过的用户可以随时发「菜单」「帮助」自助，所以长静默期不会让人卡住。
                const hintKey = `hint:unknown:${openId}`;
                const last = await db.getState(D1, hintKey, null);
                const since = last?.at ? Date.parse(String(last.at).replace(" ", "T") + "+08:00") : 0;
                if (Date.now() - since < 24 * 3600 * 1000) {
                  console.log("[feishu] 未识别输入（静默，24 小时内已提醒过）:", String(text || "").slice(0, 40));
                } else {
                  await db.setState(D1, hintKey, { at: shanghaiNow(), text: String(text || "").slice(0, 80) });
                  await sendText(env, chatId ? { type: "chat_id", id: chatId } : { type: "open_id", id: openId },
                    "没认出这条指令。发「菜单」看能用哪些指令。\n（不确定的内容我不会再重复提醒，发「菜单」随时可查。）");
                }
              }
            }
          }
        }
      }
      if (type === "application.bot.menu_v6") {
        //  D-152：机器人自定义菜单点击（仅单聊）。飞书同样要求 3 秒内 200，
        //   所以先回 200，再在 waitUntil 里跑指令（同 D-086 的理由）。
        const menuOpenId = ev?.operator?.operator_id?.open_id || null;
        const eventKey = ev?.event_key || "";
        // 结果写回 webhook 日志（processed 字段），方便排查：botmenu:handled / botmenu:<reason>
        const job = handleBotMenu(env, { openId: menuOpenId, eventKey })
          .then(async (r) => {
            const tag = r?.ok ? `botmenu:handled:${r.key}` : `botmenu:ignored:${r?.reason || "unknown"}`;
            if (logPromise) await logPromise;
            await D1.prepare(
              "UPDATE feishu_webhook_log SET processed=? WHERE id=(SELECT MAX(id) FROM feishu_webhook_log)",
            ).bind(tag).run();
            return r;
          })
          .catch((err) => {
            console.error("[bot-menu] 执行失败", err?.message);
          });
        if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(job);
        else await job;
        return new Response("{}", { status: 200, headers: JSON_HEADERS });
      }
      if (type === "card.action.trigger") {
        //  D-086 修复（200341）：飞书要求 3 秒内响应，超时会重试 3 次并给用户报错。
        //   这里只做「解析 + 立即回 toast」，真正的查库/发卡放到 waitUntil 异步做，
        //   否则 sendCard 一次就可能把响应拖过 3 秒（实测飞书连发 3 次回调）。
        const plan = planCardAction(body);
        if (plan.run) {
          const job = runCardAction(env, plan).catch((err) => {
            console.error("[feishu] 卡片动作执行失败", err?.message);
          });
          if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(job);
          else await job;
        }
        // 标记也放到异步里 —— 回调响应路径上每多一次 D1 往返就多 ~300 ms，
        // 而飞书只给 3 秒（D-086 修复 200341）。
        const mark = (async () => {
          if (logPromise) await logPromise;
          await D1.prepare(
            "UPDATE feishu_webhook_log SET processed=? WHERE id=(SELECT MAX(id) FROM feishu_webhook_log)",
          ).bind(`card:${plan.run ? "queued" : "ignored"}`).run();
        })().catch(() => {});
        if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(mark);
        return new Response(JSON.stringify({ toast: plan.toast }), {
          status: 200,
          headers: JSON_HEADERS,
        });
      }
    }
    if (logPromise) await logPromise;
    await D1.prepare(
      "UPDATE feishu_webhook_log SET processed=? WHERE id=(SELECT MAX(id) FROM feishu_webhook_log)",
    ).bind(foreign ? `ignored:foreign_app:${srcAppId}` : "handled").run();
  } catch (err) {
    console.error("[feishu] webhook 处理失败", err?.message);
    try {
      await D1.prepare(
        "UPDATE feishu_webhook_log SET processed=? WHERE id=(SELECT MAX(id) FROM feishu_webhook_log)",
      ).bind("error: " + String(err?.message || err).slice(0, 120)).run();
    } catch { /* ignore */ }
  }
  //  飞书要求 3 秒内返回 200，否则重试 3 次
  return new Response("{}", { status: 200, headers: JSON_HEADERS });
}

/** 查看飞书绑定状态 */
async function apiFeishuStatus(env) {
  const D1 = env.DB;
  const target = await db.getState(D1, "feishu:target");
  let bot = null;
  try {
    const token = await getTenantToken(env);
    const r = await fetch("https://open.feishu.cn/open-apis/bot/v3/info", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const b = await r.json();
    bot = { code: b.code, msg: b.msg, name: b?.bot?.app_name, status: b?.bot?.activate_status };
  } catch (err) {
    bot = { error: String(err?.message || err) };
  }
  // 最近一次 webhook 命中（判断飞书有没有把事件发过来）
  let lastHit = null;
  try {
    lastHit = await D1.prepare(
      "SELECT received_at, type, event_type, has_encrypt, processed, preview FROM feishu_webhook_log ORDER BY id DESC LIMIT 1",
    ).first();
  } catch { /* 表可能还没建 */ }
  let recentHits = [];
  try {
    const { results } = await D1.prepare(
      "SELECT received_at, event_type, processed FROM feishu_webhook_log ORDER BY id DESC LIMIT 10",
    ).all();
    recentHits = results || [];
  } catch { /* ignore */ }
  let chats = [];
  try {
    const d2 = await discoverChat(env);
    chats = d2 ? [d2] : [];
  } catch { /* ignore */ }
  return json({ target, bot, lastHit, recentHits, chats });
}

/** 自动发现：列出机器人所在的群并绑定 */
async function apiFeishuDiscover(env) {
  const D1 = env.DB;
  const found = await discoverChat(env);
  if (!found) {
    return json({ ok: false, error: "机器人当前不在任何群里。请在飞书里建一个群（哪怕只有你和机器人），把「理想同学」拉进去，然后再点一次。" }, 200);
  }
  if (found.error) return json({ ok: false, error: found.error }, 200);
  await db.setState(D1, "feishu:target", { ...found, at: shanghaiNow() });
  const res = await sendText(env, { type: "chat_id", id: found.id },
    "理想助手已绑定推送目标（群：" + (found.name || "未命名") + "）。\n用车数据会推送到这里。");
  return json({ ok: res.ok, target: found, send: { code: res.code, msg: res.msg } });
}

/** 手动绑定推送目标：贴飞书会话链接或 open_id */
async function apiFeishuTarget(env, request) {
  const body = await request.json().catch(() => ({}));
  const t = resolveTarget(body.target || body.id || body.link);
  if (!t) {
    return json({ ok: false, error: "无法解析目标。请贴飞书会话链接（含 oc_xxx）或 open_id。" }, 400);
  }
  await db.setState(env.DB, "feishu:target", { ...t, at: shanghaiNow() });
  // 立刻试发一条，验证权限与目标
  const res = await sendText(env, env.DB, t, "理想助手已绑定推送目标。用车数据会推送到这里。");
  return json({ ok: res.ok, target: t, send: { code: res.code, msg: res.msg } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;

    try {
      // ── 登录（写入 cookie）──
      if (p === "/login") {
        const key = url.searchParams.get("k") || "";
        if (!env.API_TOKEN || key === env.API_TOKEN) {
          const body = `<!doctype html><meta charset="utf-8"><title>登录</title>` +
            `<body style="font:16px system-ui;padding:40px;background:#0f1419;color:#e8eef5">` +
            `<h2>登录成功</h2><p>正在跳转…</p>` +
            `<script>document.cookie='li_token=${env.API_TOKEN || ""};path=/;max-age=31536000;SameSite=Lax';</script>` +
            `<script>setTimeout(()=>location.href='/',300)</script></body>`;
          return new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } });
        }
        return new Response("bad token", { status: 401 });
      }

      // ── 行程分享页（免登录，签名短链；D-079）──
      // 飞书内置浏览器没有面板 cookie，靠签名令牌代替登录；只渲染单条行程。
      if (p === "/t" || p.startsWith("/t/")) return handleTripShare(request, env, url);

      // ── 飞书事件回调（请求地址模式）──
      if (p === "/webhook/feishu" && request.method === "POST") {
        return feishuWebhook(request, env, ctx);
      }

      // ── API ──
      if (p.startsWith("/api/")) {
        const auth = await requireAuth(request, env);
        if (auth) return auth;

        if (p === "/api/status") return apiStatus(env);
        //  临时诊断（D-167）：锁车/哨兵原始取值，查完即删
        if (p === "/api/diag/vss") return apiDiagVss(env, url);
        //  全量重建 detail（可写回），D-168
        if (p === "/api/diag/detail") return apiDiagDetail(env, url);
        if (p === "/api/daily") return apiDaily(env, url);
        if (p === "/api/month") return apiMonth(env, url);
        if (p === "/api/charge") return apiCharge(env);
        if (p === "/api/schedule") return apiSchedule(env);
  if (p === "/api/pollplan") return apiPollPlan(env);
        if (p === "/api/push" && request.method === "POST") return apiManualPush(env, request);
        if (p === "/api/push") return json({ error: "POST only" }, 405);
        if (p === "/api/bills") return apiBills(env, url);
        //  D-086：指令调试口（dry_run 只回卡片 JSON，不发飞书）
        if (p === "/api/cmd" && request.method === "POST") return apiCmd(env, request);
        if (p === "/api/pushswitch" && request.method === "GET") return apiPushSwitchGet(env);
        if (p === "/api/pushswitch" && request.method === "POST") return apiPushSwitchSet(env, request);
        if (p === "/api/health") return apiHealth(env);
        if (p === "/api/trip") return apiTrip(env);
        if (p === "/api/collect" && request.method === "POST") return apiCollect(env);
        if (p === "/api/backfill" && request.method === "POST") return apiBackfill(env, url);
        if (p === "/api/credstatus") return apiCredStatus(env);
        if (p === "/api/credrotate" && request.method === "POST") return apiCredRotate(request, env);
        if (p === "/api/card/status") return apiCardStatus(env);
        if (p === "/api/bills/reprice" && request.method === "POST") return apiBillsReprice(env);
        if (p === "/api/price" && request.method === "POST") return apiSetPrice(env, request);
        if (p === "/api/price" && request.method === "GET") return apiGetPrice(env);
        //  顺序要紧：POST 必须排在 GET 之前，否则 POST /api/fuel 会被 GET 分支吞掉
        if (p === "/api/fuel" && request.method === "POST") return apiFuelPost(env, request);
        if (p === "/api/fuel") return apiFuel(env);
        if (p === "/api/geofence" && request.method === "GET") return apiGeofenceList(env);
        if (p === "/api/geofence" && request.method === "POST") return apiGeofenceAdd(env, request);
        if (p === "/api/geofence/recenter" && request.method === "POST") return apiGeofenceRecenter(env, request);
        if (p === "/api/trips" && request.method === "GET") return apiTrips(env, url);
        if (p === "/api/trips/rebuild" && request.method === "POST") return apiTripsRebuild(env, request);
        if (p === "/api/trips/backfill" && request.method === "POST") return apiTripsBackfill(env, request);
        if (p.startsWith("/api/trips/") && p.endsWith("/shot") && request.method === "POST") return apiTripShot(env, p);
        if (p.startsWith("/api/trips/") && p.endsWith("/push") && request.method === "POST") return apiTripPush(env, p);
        if (p.startsWith("/api/trips/") && request.method === "GET") return apiTripDetail(env, p);
        if (p === "/api/test-push" && request.method === "POST") return apiTestPush(env, request);
        //  D-107：卡片图标上传口（本地生成 PNG → im/v1/images → img_key 存 runtime_state）
        if (p === "/api/admin/icons" && request.method === "POST") return apiAdminIcons(env, request);
        if (p === "/api/feishu/status") return apiFeishuStatus(env);
        if (p === "/api/feishu/target" && request.method === "POST") return apiFeishuTarget(env, request);
        if (p === "/api/feishu/discover" && request.method === "POST") return apiFeishuDiscover(env);
        if (p === "/api/push-preview" && request.method === "POST") return apiPushPreview(env, url);
        return json({ error: "not found", path: p }, 404);
      }

      // ── 车模等大文件走 R2 ──
      if (p.startsWith("/models/") && env.MEDIA) {
        const key = p.replace(/^\//, "");   //  R2 里的键就是 "models/car.glb"
        const obj = await env.MEDIA.get(key);
        if (!obj) return new Response("model not found", { status: 404 });
        const headers = new Headers();
        headers.set("Content-Type", "model/gltf-binary");
        headers.set("Cache-Control", "public, max-age=31536000, immutable");
        headers.set("Access-Control-Allow-Origin", "*");
        return new Response(obj.body, { headers });
      }

      // ── 静态资源（带分级缓存头，D-194）──
      return await serveStatic(request, env, p);
    } catch (err) {
      const msg = String(err && err.message || err);
      //  落库，tail 不可用时也能看到真实异常
      try {
        await env.DB.prepare(`
          INSERT INTO runtime_state (k, v, updated_at) VALUES ('last_error', ?, ?)
          ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at
        `).bind(JSON.stringify({ message: msg, stack: String(err && err.stack || "").slice(0, 900), at: shanghaiNow() }), shanghaiNow()).run();
      } catch { /* ignore */ }
      console.error("[worker] 未捕获异常:", msg, err && err.stack);
      return json({ error: "internal", message: msg }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCollect(env, { source: "cron" }));
  },
};

async function runCollect(env, meta = {}) {
  const t0 = Date.now();
  try {
    const res = await collect(env, { log: (m) => console.log("[collect]", m) });
    console.log("[collect] done", JSON.stringify({ ...meta, ms: Date.now() - t0, ...res }));
    return res;
  } catch (err) {
    console.error("[collect] failed", err && err.message, err && err.stack);
    return { error: String(err && err.message || err) };
  }
}

// ─────────────────────────────────────────── API

async function apiStatus(env) {
  const D1 = env.DB;
  const vehicle = await db.getVehicle(D1);
  if (!vehicle) return json({ error: "no vehicle cached" }, 404);
  //  D-093：detail 现在存 runtime_state（不再把整包 VSS 写进每行采样）
  const detailState = await db.getState(D1, "last:detail", null);
  const s = await db.lastSample(D1, vehicle.vin);
  const trip = s?.trip_total_json ? safeJson(s.trip_total_json, null) : null;
  const health = await db.listHealth(D1, vehicle.vin);
  const tripParsed = tripView(trip);
  return json({
    vehicle: {
      vin: vehicle.vin, spu: vehicle.spu, nickname: vehicle.nickname,
      plate_no: vehicle.plate_no, seat_count: vehicle.seat_count, energy_type: vehicle.energy_type,
    },
    sample: s ? {
      sampled_at: s.sampled_at, battery: s.battery, range_km: s.range_km,
      odometer_km: s.odometer_km, speed: s.speed, indoor_temp: s.indoor_temp,
      outdoor_temp: s.outdoor_temp, charging: s.charging, charge_status: s.charge_status,
      travel_status: s.travel_status,
      detail: detailState || buildDetail(safeJson(s.payload, {})),
    } : null,
    trip: tripParsed,
    health,
    server_time: shanghaiNow(),
  });
}

/** 临时诊断（D-167）：只读拉几条 VSS，看锁车/哨兵的真实取值与类型。 */
async function apiDiagVss(env, url) {
  const D1 = env.DB;
  const vehicle = await db.getVehicle(D1);
  const client = await buildClient(env, D1);
  const paths = [
    "Vehicle.Body.DoorLockStatus.MainDoor",
    "Vehicle.Body.DoorLockStatus.CopilotDoor",
    "Vehicle.Body.DoorLockStatus.BackLeftDoor",
    "Vehicle.Body.DoorLockStatus.BackRightDoor",
    "Vehicle.Body.DoorLockStatus.TrunkDoor",
    "Vehicle.Body.DoorLockStatus.FrontTrunkDoor",
    "Vehicle.Body.DoorSwitchStatus.MainDoor",
    "Vehicle.Sentry.SentinelStatus",
    "Vehicle.Sentry.SettingsStatus",
    "Vehicle.Sentry.Video.Count",
    "Vehicle.Cabin.TravelStatus",
  ];
  let raw = null, err = null;
  try { raw = await client.getVss(paths, { maxSubrequests: 4 }); } catch (e) { err = String(e && e.message || e); }
  const dump = {};
  for (const k of paths) {
    const v = raw ? raw[k] : undefined;
    dump[k] = { type: typeof v, json: v === undefined ? null : (typeof v === "string" ? v : JSON.stringify(v)) };
  }
  //  ?watch=<秒> 时在窗口内每 4 秒采一次哨兵/锁车，收集出现过的不同取值组合
  //  （用户远程开/关哨兵一次，就能把枚举值和状态对应起来，D-167 未验证项）
  const watch = Math.min(300, Math.max(0, Number(url?.searchParams.get("watch")) || 0));
  if (raw && watch) {
    const seen = new Map();
    const keyOf = (r) => {
      const st = pickJson(r, "Vehicle.Sentry.SentinelStatus") || {};
      const sw = pickJson(r, "Vehicle.Sentry.SettingsStatus") || {};
      return `switch=${sw.sentinelSwitch ?? "-"} status=${st.sentinelStatus ?? "-"} sub=${st.sentinelSubStatus ?? "-"}`;
    };
    seen.set(keyOf(raw), new Date().toISOString());
    const until = Date.now() + watch * 1000;
    while (Date.now() < until) {
      if (Date.now() + 6000 > until) break;
      await new Promise((r) => setTimeout(r, 6000));
      try {
        const r2 = await client.getVss(["Vehicle.Sentry.SentinelStatus", "Vehicle.Sentry.SettingsStatus"], { maxSubrequests: 2 });
        if (r2) {
          const k = keyOf(r2);
          if (!seen.has(k)) seen.set(k, new Date().toISOString());
        }
      } catch (e) { /* 单次失败忽略，继续采 */ }
    }
    const samples = [...seen.entries()].map(([combo, firstSeen]) => ({ combo, firstSeen }));
    await db.setState(D1, "sentinel:probe", { at: shanghaiNow(), watch, samples });
    return json({ vin_tail: String(vehicle?.vin || "").slice(-4), watch, samples, built: (buildDetail(raw) || {}) && { sentinel_text: buildDetail(raw).sentinel_text } });
  }
  const built = raw ? buildDetail(raw) : null;
  //  D-168：这里禁止写 last:detail —— 只拉了 11 条 path，buildDetail 出来的油量/续航/电压/OTA/胎压全是 null，
  //  写回去就会把缓存打烂（曾发生一次）。要刷新 detail 请用 /api/diag/detail（全量 VSS）。
  return json({
    vin_tail: String(vehicle?.vin || "").slice(-4), err, dump,
    built: built ? { locked: built.locked, sentinel_text: built.sentinel_text, travel: built.travel_status_text } : null,
  });
}

async function apiDaily(env, url) {
  const D1 = env.DB;
  const vehicle = await db.getVehicle(D1);
  if (!vehicle) return json({ error: "no vehicle cached" }, 404);
  const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days")) || 14));
  const to = shanghaiDate();
  const from = shanghaiDate(new Date(Date.now() - days * 24 * 3600 * 1000));
  const rows = await db.listDaily(D1, vehicle.vin, from, to);
  const price = await db.currentPrice(D1);
  const fuelPrice = await db.currentFuelPrice(D1);
  return json({ from, to, price_cny: price, fuel_price_cny: fuelPrice, rows });
}

/** 全量拉 VSS 重建 detail，?write=1 时写回 last:detail（D-168：status 卡字段缺失的补救口）。 */
async function apiDiagDetail(env, url) {
  const D1 = env.DB;
  const client = await buildClient(env, D1);
  const vss = await client.getVss(VSS_PATHS, { maxSubrequests: 20 });
  const detail = buildDetail(vss);
  const missing = Object.entries(detail).filter(([, v]) => v === null || v === undefined).map(([k]) => k);
  //  写回前先体检：last:detail 是整包快照，没有「合并」语义，字段大面积为空时写进去会把卡片打残（D-168 事故）。
  //  超过 3 个字段为空就拒绝写入，除非显式 force=1。
  const tooSparse = missing.length > 3;
  const wantWrite = url && url.searchParams.get("write") === "1";
  const force = url && url.searchParams.get("force") === "1";
  const wrote = Boolean(wantWrite && (!tooSparse || force));
  if (wrote) await db.setState(D1, "last:detail", detail);
  return json({
    wrote, tooSparse,
    paths: VSS_PATHS.length,
    keys: Object.keys(detail).length,
    missing,
    fuel_level: detail.fuel_level, range_elec: detail.range_elec, range_fuel: detail.range_fuel,
    pack_voltage: detail.pack_voltage, ota_version: detail.ota_version, tires: detail.tires,
    locked: detail.locked, sentinel_text: detail.sentinel_text,
  });
}

/** 车机行程表 → 卡片/接口用的视图字段（避免两处重复换算） */

/** 纯日期加减（YYYY-MM-DD，按 UTC 算，避免 Workers 时区陷阱；D-121 周报取上一周用） */
function addDaysStr(dateStr, delta) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function tripView(trip) {
  if (!trip) return null;
  return {
    mileage_km: trip.mileage ? trip.mileage / 1000 : null,
    ad_km: trip.adMileage ? trip.adMileage / 1000 : null,
    noa_km: trip.noaMileage ? trip.noaMileage / 1000 : null,
    lcc_km: trip.lccMileage ? trip.lccMileage / 1000 : null,
    acc_km: trip.accMileage ? trip.accMileage / 1000 : null,
    cd_km: trip.cdMileage ? trip.cdMileage / 1000 : null,
    engine_km: trip.engineMileage ? trip.engineMileage / 1000 : null,
    ad_days: trip.adMileageDate ?? null,
    city_noa_days: trip.cityNoaDays ?? null,
    city_noa_km: trip.cityNoaMileage ? trip.cityNoaMileage / 1000 : null,
    hwy_noa_days: trip.highWayNoaDays ?? null,
    hwy_noa_km: trip.highWayNoaMileage ? trip.highWayNoaMileage / 1000 : null,
  };
}

/** 推送时间表（Web 面板用，D-071） */
/** 自适应轮询状态（D-093）：当前间隔、下一次采集、今日采集次数 */
async function apiPollPlan(env) {
  const D1 = env.DB;
  const vehicle = await db.getVehicle(D1);
  const vin = vehicle?.vin;
  const plan = vin ? await db.getState(D1, "poll:plan", null) : null;
  const today = shanghaiNow().slice(0, 10);
  // 只统计「部署后」的窗口，避免刚上线当天算出 100% 的假节省
  const startedMs = Number(plan?.started_at_ms) || Date.now();
  const minutesSoFar = Math.max(1, Math.round((Date.now() - startedMs) / 60000));
  const polls = plan?.polls_date === today ? Number(plan.polls_today || 0) : 0;
  return json({
    ok: true,
    server_time: shanghaiNow(),
    plan: plan ? {
      mode: plan.mode,
      interval_sec: plan.interval_sec,
      at_home: plan.at_home,
      changed: plan.changed,
      next_at: plan.next_at_ms ? msToShanghai(plan.next_at_ms) : null,
      next_in_sec: plan.next_at_ms ? Math.max(0, Math.round((plan.next_at_ms - Date.now()) / 1000)) : null,
      last_at: plan.last_at_ms ? msToShanghai(plan.last_at_ms) : null,
      idle_sec: plan.last_change_at_ms ? Math.round((Date.now() - plan.last_change_at_ms) / 1000) : null,
    } : null,
    today: {
      polls, minutes: minutesSoFar,
      skipped: Math.max(0, minutesSoFar - polls),
      saved_pct: Math.max(0, Math.round((1 - Math.min(polls, minutesSoFar) / minutesSoFar) * 100)),
    },
  });
}

function minutesSinceMidnightShanghai() {
  const t = shanghaiNow();               // "YYYY-MM-DD HH:MM:SS"
  const hh = Number(t.slice(11, 13));
  const mm = Number(t.slice(14, 16));
  return hh * 60 + mm;
}

function msToShanghai(ms) {
  return new Date(ms + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
}

async function apiSchedule(env) {
  const D1 = env.DB;
  const vehicle = await db.getVehicle(D1);
  const now = shanghaiNow();
  const next = nextRuns(now);
  const target = await db.getState(D1, "feishu:target");
  const recent = vehicle ? await db.listPushed(D1, vehicle.vin, 12) : [];
  const todayCount = vehicle ? await db.countPushedSince(D1, vehicle.vin, now.slice(0, 10)) : 0;
  return json({
    server_time: now,
    timezone: "Asia/Shanghai",
    cron: "* * * * *",
    target: target ? { type: target.type, id: target.id } : null,
    today_count: todayCount,
    tasks: [
      { kind: "collect", label: "状态采集", cadence: "每分钟", window: "全天", next: "下一分钟" },
      { kind: "daily", label: "昨日用车小结", cadence: "每天", window: "07:30 – 07:40", next: next.daily },
      { kind: "weekly", label: "本周小结", cadence: "每周一", window: "08:00 – 08:10", next: next.weekly },
      { kind: "monthly", label: "本月小结", cadence: "每月 1 日", window: "08:30 – 08:40", next: next.monthly },
    ],
    recent,
  });
}

/** 手动触发一次推送（Web 面板按钮用，D-071） */
async function apiManualPush(env, request) {
  const D1 = env.DB;
  const vehicle = await db.getVehicle(D1);
  if (!vehicle) return json({ ok: false, error: "车辆信息未初始化" }, 404);
  const body = await request.json().catch(() => ({}));
  const kind = String(body.kind || "").trim();
  const target = await db.getState(D1, "feishu:target");
  if (!target) return json({ ok: false, error: "还没绑定飞书推送目标" }, 400);
  const vin = vehicle.vin;
  const now = new Date();
  const stamp = shanghaiNow();
  const price = await db.currentPrice(D1);
  const fuelPrice = await db.currentFuelPrice(D1);
  let card = null;
  let info = {};

  if (kind === "status") {
    const detailState = await db.getState(D1, "last:detail", null);
    const s = await db.lastSample(D1, vin);
    if (!s) return json({ ok: false, error: "暂无采集数据" }, 400);
    const health = await db.listHealth(D1, vin);
    const icons = await db.getState(D1, "card:icons", null);
    card = cards.buildStatusCard({
      s: { ...s, detail: detailState || buildDetail(safeJson(s.payload, {})) },
      trip: tripView(s.trip_total_json ? safeJson(s.trip_total_json, null) : null),
      vehicle,
      health,
      icons,
    });
    info = { sampled_at: s.sampled_at };
  } else if (kind === "daily") {
    const date = String(body.date || shanghaiDate(new Date(Date.now() - 24 * 3600 * 1000)));
    const row = await db.getDaily(D1, vin, date);
    if (!row) return json({ ok: false, error: `${date} 还没有日汇总（该天可能没采集到）` }, 400);
    //  D-078：手动重推也用「该日之前最近一次充电的电价」，与定时任务口径一致
    const up = await collectorTest.usagePrice(D1, vin, `${date} 23:59:59`);
    card = cards.buildDailyCard({
      d: row, vehicle, priceCny: up.price, fuelPriceCny: fuelPrice, dateLabel: date,
      priceNote: up.at ? `按 ${String(up.at).slice(5, 16)} 那次充电的电价` : "按默认电价",
      icons: await db.getState(D1, "card:icons", null),
    });
    info = { date, price: up.price };
  } else if (kind === "weekly") {
    const { from, to } = lastWeekRange(now);
    const rows = await db.listDaily(D1, vin, from, to);
    if (!rows.length) return json({ ok: false, error: `${from} ~ ${to} 没有数据` }, 400);
    //  D-121：周报电费与日报同口径——用「周内最近一次充电的电价」算行驶电费，
    //   不再直接 SUM 日汇总 cost_cny（有充电的日子那里存的是充电实付，会虚高）。
    const up = await collectorTest.usagePrice(D1, vin, `${to} 23:59:59`);
    const prevRows = await db.listDaily(D1, vin, addDaysStr(from, -7), addDaysStr(from, -1));
    card = cards.buildWeeklyCard({
      summary: summarizeRows(rows), days: rows,
      weekLabel: `${from} ~ ${to}`, highlights: highlightsRows(rows),
      energy: energyAggregate(rows), prev: energyAggregate(prevRows),
      vehicle, priceCny: up.price, icons: await db.getState(D1, "card:icons", null),
    });
    info = { from, to };
  } else if (kind === "monthly") {
    const { from, to, month } = lastMonthRange(now);
    const rows = await db.listDaily(D1, vin, from, to);
    if (!rows.length) return json({ ok: false, error: `${month} 没有数据` }, 400);
    const pmRange = monthRangeOf(monthBefore(month));
    const pmRows = await db.listDaily(D1, vin, pmRange.from, pmRange.to);
    const upM = await collectorTest.usagePrice(D1, vin, `${to} 23:59:59`);
    card = cards.buildMonthlyCard({
      summary: summarizeRows(rows), days: rows,
      monthLabel: month, highlights: highlightsRows(rows),
      fuel: await collectorTest.fuelSummary(env.DB, vin, from, to),
      vehicle, priceCny: upM.price, icons: await db.getState(D1, "card:icons", null),
      prev: summarizeRows(pmRows), title: "上月用车小结",
    });
    info = { month };
  } else if (kind === "sample") {
    // 提醒卡样式预览：POST /api/push {"kind":"sample","what":"maint|ota|drain|fault"}
    const what = String(body?.what || "maint");
    card = sampleReminderCard(what);
    info = { what, note: "示例卡，非真实事件" };
  } else {
    return json({ ok: false, error: `未知 kind: ${kind}（可用 status/daily/weekly/monthly/sample）` }, 400);
  }

  // 手动推送也写 push_log（便于在「最近推送」里看到），但不占用定时任务的幂等键
  const key = `manual:${kind}:${stamp.slice(0, 16)}`;
  await db.markPushed(D1, vin, key, "feishu", { kind, ...info });
  const res = await sendCard(env, target, card);
  return json({ ok: res.ok, kind, key, info, msg: res.msg || "success" });
}

/** D-086：指令调试口。dry_run=1 只返回卡片 JSON（不发给飞书），便于本地/线上核对结构 */
async function apiCmd(env, request) {
  const body = await request.json().catch(() => ({}));
  const text = String(body.text || "").trim();
  if (!text) return json({ ok: false, error: "缺少 text" }, 400);
  const dryRun = body.dry_run === true || body.dry_run === 1 || body.dry_run === "1";
  const r = await handleTextCommand(env, {
    text,
    chatId: body.chat_id ? String(body.chat_id) : null,
    dryRun,
  });
  return json({
    ok: r.ok !== false, handled: !!r.handled, kind: r.kind || null, msg: r.msg || "",
    //  D-158：有卡就回卡（推送开关这类），否则回文字 payload
    ...(dryRun ? { card: r.card || r.payload } : {}),
  });
}

/** D-086：查看推送开关 */
async function apiPushSwitchGet(env) {
  const sw = await getSwitches(env.DB);
  return json({ switches: sw, labels: SWITCH_LABELS, kinds: SWITCH_KINDS });
}

/** D-086：设置推送开关 {kind, on} */
async function apiPushSwitchSet(env, request) {
  const body = await request.json().catch(() => ({}));
  const kind = String(body.kind || "").trim();
  if (!SWITCH_KINDS.includes(kind)) {
    return json({ ok: false, error: `未知 kind: ${kind}（可用 ${SWITCH_KINDS.join("/")}）` }, 400);
  }
  const on = body.on === true || body.on === 1 || body.on === "1" || body.on === "true";
  const sw = await setSwitch(env.DB, kind, on);
  return json({ ok: true, kind, on, switches: sw });
}

/** 充电账单 + 电价分摊（D-071） */
async function apiBills(env, url) {
  const D1 = env.DB;
  const vehicle = await db.getVehicle(D1);
  if (!vehicle) return json({ error: "no vehicle cached" }, 404);
  const month = url.searchParams.get("month") || shanghaiDate().slice(0, 7);
  const all = await db.listChargeSessions(D1, vehicle.vin, 200);
  const rows = (all || []).filter((r) => String(r.started_at || "").slice(0, 7) === month);
  const tiers = await db.listElecTiers(D1);
  const prices = (tiers || []).map((t) => num(t.price)).filter((v) => v !== null);
  const lo = prices.length ? Math.min(...prices) : null;
  const hi = prices.length ? Math.max(...prices) : null;
  const band = (p) => {
    if (p === null || lo === null) return null;
    if (p < lo - 0.02) return "历史价";      // D-068 之前用平铺电价 0.62 结算的历史会话
    if (p <= lo + 0.02) return "谷时";
    if (p >= hi - 0.02) return "峰时";
    return "平时";
  };
  const detailed = rows.map((r) => {
    const kwh = num(r.capacity_kwh);
    const cost = num(r.cost_cny);
    const price = num(r.price_per_kwh) ?? (kwh > 0 && cost !== null ? round(cost / kwh, 3) : null);
    return {
      id: r.id, session_key: r.session_key,
      started_at: r.started_at, ended_at: r.ended_at,
      duration_min: num(r.duration_min), capacity_kwh: kwh,
      charging_type: num(r.charging_type), avg_power_kw: num(r.avg_power_kw),
      price_per_kwh: price, cost_cny: cost, band: band(price),
      confirmed: num(r.confirmed),
    };
  });
  const sum = detailed.reduce((a, r) => ({
    sessions: a.sessions + 1,
    kwh: a.kwh + (r.capacity_kwh || 0),
    cost: a.cost + (r.cost_cny || 0),
  }), { sessions: 0, kwh: 0, cost: 0 });
  sum.kwh = round(sum.kwh, 2);
  sum.cost = round(sum.cost, 2);
  sum.avg_price = sum.kwh > 0 ? round(sum.cost / sum.kwh, 3) : null;
  const byType = {};
  for (const r of detailed) {
    const t = r.charging_type || 0;
    byType[t] = byType[t] || { sessions: 0, kwh: 0, cost: 0 };
    byType[t].sessions += 1;
    byType[t].kwh += r.capacity_kwh || 0;
    byType[t].cost += r.cost_cny || 0;
  }
  for (const t of Object.keys(byType)) {
    byType[t].kwh = round(byType[t].kwh, 2);
    byType[t].cost = round(byType[t].cost, 2);
  }
  return json({ month, tiers, rows: detailed, summary: { ...sum, by_type: byType } });
}

async function apiMonth(env, url) {
  const D1 = env.DB;
  const vehicle = await db.getVehicle(D1);
  if (!vehicle) return json({ error: "no vehicle cached" }, 404);
  const month = url.searchParams.get("month") || shanghaiDate().slice(0, 7);
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const from = `${month}-01`;
  const to = `${month}-${String(last).padStart(2, "0")}`;
  const rows = await db.listDaily(D1, vehicle.vin, from, to);
  const sum = rows.reduce((a, d) => ({
    travel_km: a.travel_km + num(d.travel_km),
    elec_km: a.elec_km + num(d.elec_km),
    hybrid_km: a.hybrid_km + num(d.hybrid_km),
    elec_kwh: a.elec_kwh + num(d.elec_kwh),
    fuel_l: a.fuel_l + num(d.fuel_l),
    cost_cny: a.cost_cny + num(d.cost_cny),
    fuel_cost_cny: a.fuel_cost_cny + num(d.fuel_cost_cny),
    charge_kwh: a.charge_kwh + num(d.charge_kwh),
    charge_times: a.charge_times + num(d.charge_times),
    ad_km: a.ad_km + num(d.ad_km),
  }), { travel_km: 0, elec_km: 0, hybrid_km: 0, elec_kwh: 0, fuel_l: 0, cost_cny: 0, fuel_cost_cny: 0, charge_kwh: 0, charge_times: 0, ad_km: 0 });
  sum.total_cost = round(sum.cost_cny + sum.fuel_cost_cny, 2);
  sum.pure_ratio = sum.travel_km > 0 ? (sum.elec_km / sum.travel_km) * 100 : 0;
  const best = rows.filter((r) => num(r.travel_km) > 0)
    .sort((a, b) => (num(a.elec_km) / Math.max(1, num(a.travel_km))) - (num(b.elec_km) / Math.max(1, num(b.travel_km))))[0];
  return json({
    month, rows, summary: sum,
    highlights: best ? [{ label: "最" + (sum.pure_ratio >= 60 ? "省" : "费油") + "的一天", value: `${best.stat_date} · 纯电占比 ${(num(best.elec_km) / Math.max(1, num(best.travel_km)) * 100).toFixed(0)}%` }] : [],
  });
}

async function apiCharge(env) {
  const D1 = env.DB;
  const vehicle = await db.getVehicle(D1);
  if (!vehicle) return json({ error: "no vehicle cached" }, 404);
  const rows = await db.listChargeSessions(D1, vehicle.vin, 50);
  const price = await db.currentPrice(D1);
  return json({ price_cny: price, rows });
}

async function apiHealth(env) {
  const D1 = env.DB;
  const vehicle = await db.getVehicle(D1);
  if (!vehicle) return json({ error: "no vehicle cached" }, 404);
  return json({ health: await db.listHealth(D1, vehicle.vin), server_time: shanghaiNow() });
}

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

async function apiTrip(env) {
  const D1 = env.DB;
  const vehicle = await db.getVehicle(D1);
  if (!vehicle) return json({ error: "no vehicle cached" }, 404);
  const s = await db.lastSample(D1, vehicle.vin);
  const raw = s?.trip_total_json ? safeJson(s.trip_total_json, null) : null;
  return json({ raw, parsed: raw ? parseTripTotal({ "Vehicle.Carcenter.Trip.Total": { value: raw } }) : null });
}

/** 回填最近 N 天的日汇总（每天 1 次 travel/daily/aggregate 单日调用） */
async function apiBackfill(env, url) {
  const D1 = env.DB;
  const vehicle = await db.getVehicle(D1);
  if (!vehicle) return json({ error: "no vehicle cached" }, 404);
  const client = await buildClient(env, D1);
  client.vin = vehicle.vin;

  // 支持两种用法：
  //   ?days=20                       → 最近 20 天（不含今天）
  //   ?from=2026-09-01&to=2026-09-30 → 指定区间（回填历史月份用）
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");
  let dates = [];
  if (fromParam && toParam) {
    const a = new Date(`${fromParam}T00:00:00Z`);
    const b = new Date(`${toParam}T00:00:00Z`);
    for (let t = a.getTime(); t <= b.getTime(); t += 24 * 3600 * 1000) {
      dates.push(shanghaiDate(new Date(t)));
    }
    dates = dates.slice(0, 31);       // 单次上限 31 天（受子请求数限制）
  } else {
    const days = Math.min(25, Math.max(1, Number(url.searchParams.get("days")) || 20));
    for (let i = days; i >= 1; i--) {
      dates.push(shanghaiDate(new Date(Date.now() - i * 24 * 3600 * 1000)));
    }
  }

  const out = [];
  for (const d of dates) {
    const r = await client.travel(
      `/ssp-travel-x-service/v1-0/travel/daily/aggregate/${vehicle.vin}?startDate=${d}&endDate=${d}`);
    if (r.code !== 0 || !r.data) { out.push({ date: d, ok: false, code: r.code }); continue; }
    const t = r.data;
    const price = await db.currentPrice(D1);
    const fuelPrice = await db.currentFuelPrice(D1);
    const elecKwh = num(t.elecEnergy), fuelL = num(t.fuelConsumption);
    await db.upsertDaily(D1, {
      vin: vehicle.vin, stat_date: d,
      travel_km: num(t.travelMileage), elec_km: num(t.elecMileage), hybrid_km: num(t.hybridMileage),
      elec_kwh: elecKwh, fuel_l: fuelL,
      avg_elec_kwh_per_100km: num(t.avgElecEnergy, null),
      avg_fuel_l_per_100km: num(t.avgFuelConsumption, null),
      ad_km: 0, noa_km: 0, charge_kwh: 0, charge_times: 0,
      cost_cny: price !== null ? round(elecKwh * price, 2) : 0,
      fuel_cost_cny: fuelPrice !== null ? round(fuelL * fuelPrice, 2) : 0,
      source: "travel",
    });
    out.push({ date: d, ok: true, km: num(t.travelMileage) });
  }
  return json({ ok: true, count: dates.length, from: dates[0], to: dates[dates.length - 1], out });
}

async function apiCollect(env) {
  const res = await runCollect(env, { source: "manual" });
  return json(res);
}


/**
 * 上传卡片图标（一次一批）。
 * 为什么要有这个口：卡片里的图标必须是飞书 img_key，而生成 PNG 要本地环境（Pillow），
 * Worker 里不能做图片编码（Free 版 CPU 10ms）；所以本地画好、这里只做「解码 + 上传 + 记 key」。
 * body: { icons: [{ name: "battery", b64: "<base64>" }] } → runtime_state["card:icons"]
 */
async function apiAdminIcons(env, request) {
  const body = await request.json().catch(() => null);
  const list = Array.isArray(body?.icons) ? body.icons : [];
  if (!list.length) return json({ error: "icons[] required" }, 400);
  const map = (await db.getState(env.DB, "card:icons", null)) || {};
  const out = {};
  for (const it of list) {
    if (!it?.name || !it?.b64) continue;
    try {
      const bin = atob(String(it.b64));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const key = await uploadImage(env, bytes, "image/png", `${it.name}.png`);
      if (key) {
        map[it.name] = key;
        out[it.name] = key;
      }
    } catch (err) {
      out[it.name] = `ERR ${String(err && err.message || err).slice(0, 80)}`;
    }
  }
  await db.setState(env.DB, "card:icons", map);
  return json({ ok: true, icons: out, total: Object.keys(map).length });
}

async function apiCardStatus(env) {
  const D1 = env.DB;
  const vehicle = await db.getVehicle(D1);
  if (!vehicle) return json({ error: "no vehicle cached" }, 404);
  //  D-093/D-096：detail 存在 runtime_state，sample.payload 里没有 → 必须显式取
  const detailState = await db.getState(D1, "last:detail", null);
  const s = await db.lastSample(D1, vehicle.vin);
  const trip = s?.trip_total_json ? safeJson(s.trip_total_json, null) : null;
  const health = await db.listHealth(D1, vehicle.vin);
  const icons = await db.getState(D1, "card:icons", null);
  //  D-114：`POST /api/test-push {"kind":"daily","sample":{...}}` 用「真实日汇总 + 覆盖字段」渲染并按真发，
  //   用来验收极端组合（一天同时有智驾/充电/用油），不必等真实事件发生。
  if (body.kind === "daily" && vehicle) {
    const date = String(body.date || shanghaiDate(new Date(Date.now() - 24 * 3600 * 1000)));
    const row = await db.getDaily(D1, vehicle.vin, date);
    if (!row) return json({ ok: false, error: `${date} 没有日汇总` }, 400);
    const merged = { ...row, ...(body.sample || {}) };
    const up = await collectorTest.usagePrice(D1, vehicle.vin, `${date} 23:59:59`);
    const ne = await db.currentFuelPrice(D1);
    const card = cards.buildDailyCard({
      d: merged, vehicle, priceCny: body.price ?? up.price, fuelPriceCny: ne, dateLabel: date,
      priceNote: up.at ? `按 ${String(up.at).slice(5, 16)} 那次充电的电价` : null, icons,
    });
    const res = await sendCard(env, target, card);
    return json({ ok: res.ok, code: res.code, msg: res.msg, date, sample: body.sample || null });
  }
  const card = cards.buildStatusCard({
    s: s ? { ...s, detail: detailState || buildDetail(safeJson(s.payload, {})) } : {},
    trip: tripView(trip),
    vehicle, health, icons,
  });
  return json(card);
}

async function apiSetPrice(env, request) {
  const body = await request.json().catch(() => ({}));
  const D1 = env.DB;
  const out = {};
  if (body.electric !== undefined && body.electric !== null) {
    await db.setDefaultPrice(D1, Number(body.electric));
    out.electric = Number(body.electric);
  }
  if (body.fuel !== undefined && body.fuel !== null) {
    await db.setFuelPrice(D1, Number(body.fuel));
    out.fuel = Number(body.fuel);
  }
  //  D-068：分时段电价（峰谷）整组覆盖
  //   body = { tiers: [{from:"01:00", to:"05:00", price:0.68, label:"谷"}, …] }
  if (Array.isArray(body.tiers)) {
    await db.setElecTiers(D1, body.tiers);
    out.tiers = body.tiers.length;
  }
  return json({ ok: true, ...out });
}

/** 从飞书消息体里取纯文本（content 是 JSON 字符串） */
function feishuText(message) {
  const raw = message?.content;
  if (!raw) return "";
  try { return String(JSON.parse(raw)?.text || "").trim(); } catch { return ""; }
}

/**
 *  D-068：用户回一个数字 → 记录 95# 油价。
 *
 * 只在存在「待录入油价」的加油事件（runtime_state `fuel:pending_price`）时生效，
 * 避免把普通聊天里的数字误当油价。录入后把 `at` 置空 → 下一次数字不会再被这条吞掉。
 */
/** 加油状态（D-068）：当前油价 / 最近一次加油事件 / 待录入 */
async function apiFuel(env) {
  const D1 = env.DB;
  const price = await db.currentFuelPrice(D1);
  const last = await db.getState(D1, "fuel:last");
  const pending = await db.getState(D1, "fuel:pending_price");
  return json({
    fuel_price_cny: price,
    last: last || null,
    pending: pending && pending.at ? pending : null,
  });
}

/** 当前电价 / 分时段电价表 / 油价（D-068） */
async function apiGetPrice(env) {
  const D1 = env.DB;
  const vehicle = await db.getVehicle(D1);
  const usage = vehicle ? await db.getState(D1, "usage:price") : null;
  return json({
    electric: await db.currentPrice(D1),
    fuel: await db.currentFuelPrice(D1),
    tiers: await db.listElecTiers(D1),
    //  D-078：用车电费口径 = 上次充电的实际电价 + 每 1% 电量对应的度数
    usage: usage || null,
    usage_note: "日报/行程卡的电费都按 usage.price（上次充电电价）计，直到下次充电",
  });
}

/**
 *  D-078：按分时电价表重算历史会话电价 + 日汇总电费（一次性修数据）。
 *   POST /api/bills/reprice
 */
async function apiBillsReprice(env) {
  const D1 = env.DB;
  const vehicle = await db.getVehicle(D1);
  if (!vehicle) return json({ error: "车辆未初始化" }, 400);
  const logs = [];
  const out = await collectorTest.repriceHistory(env, D1, vehicle.vin, (m) => logs.push(m));
  return json({ ok: true, ...out, logs });
}

/**
 * 手动补录 / 测试加油事件（D-068）。
 *   { liters: 23.4, from: 22, to: 61, at?: "2026-11-03 10:10:00", push?: true }
 * 用途：① 自动检测漏判时补录；② 部署后做端到端验证（推一张真卡）。
 */
async function apiFuelPost(env, request) {
  const body = await request.json().catch(() => ({}));
  const D1 = env.DB;
  const vehicle = await db.getVehicle(D1);
  if (!vehicle) return json({ error: "车辆未初始化" }, 400);
  if (body.price !== undefined && body.price !== null) {
    await db.setFuelPrice(D1, Number(body.price));
    return json({ ok: true, fuel_price_cny: Number(body.price) });
  }
  const liters = Number(body.liters);
  if (!Number.isFinite(liters) || liters <= 0) return json({ error: "需要 liters（>0）" }, 400);
  const from = body.from !== undefined ? Number(body.from) : null;
  const to = body.to !== undefined ? Number(body.to) : null;
  const at = body.at || shanghaiNow();
  const event = {
    at, started_at: at, ended_at: shanghaiNow(),
    from, to, delta_pct: from !== null && to !== null ? to - from : null,
    liters, tank_l: 60, manual: true,
  };
  const key = `fuel:manual:${String(at).slice(0, 16)}`;
  if (!(await db.markPushed(D1, vehicle.vin, key, "feishu", event))) {
    return json({ ok: true, duplicated: true, key });
  }
  const fuelPrice = await db.currentFuelPrice(D1);
  const target = await db.getState(D1, "feishu:target");
  const card = cards.buildFuelCard({ event, lastPriceCny: fuelPrice, rangeFuel: body.rangeFuel ?? 205, vehicle, icons, done: !!body.done });
  const res = target
    ? await sendCard(env, target, card)
    : { ok: false, msg: "未绑定飞书目标" };
  await db.setState(D1, "fuel:pending_price", {
    at, liters, delta_pct: event.delta_pct, created_at: shanghaiNow(),
  });
  await db.setState(D1, "fuel:last", event);
  return json({ ok: res.ok, key, pushed: res.ok, msg: res.msg || null });
}

/** 地理围栏列表（D-060/D-068：位置采集已修，围栏数据源恢复） */
async function apiGeofenceList(env) {
  const D1 = env.DB;
  const vehicle = await db.getVehicle(D1);
  const rows = vehicle ? await db.listGeofences(D1, vehicle.vin) : [];
  return json({ rows });
}

/** 新增/覆盖地理围栏：{ label, lat, lon, radius_m?, dwell_sec? } */

async function apiGeofenceAdd(env, request) {
  const body = await request.json().catch(() => ({}));
  const D1 = env.DB;
  const vehicle = await db.getVehicle(D1);
  if (!vehicle) return json({ error: "车辆未初始化" }, 400);
  if (!body.label || body.lat === undefined || body.lon === undefined) {
    return json({ error: "需要 label / lat / lon" }, 400);
  }
  await db.upsertGeofence(D1, {
    vin: vehicle.vin,
    label: String(body.label),
    lat: Number(body.lat),
    lon: Number(body.lon),
    radius_m: body.radius_m !== undefined ? Number(body.radius_m) : 400,
    dwell_sec: body.dwell_sec !== undefined ? Number(body.dwell_sec) : 300,
  });
  return json({ ok: true, rows: await db.listGeofences(D1, vehicle.vin) });
}

/**
 * 用车自己的历史停车点「学」出围栏中心与半径（D-073）
 *
 * 为什么需要：现有围栏中心来自高德 geocode（GCJ-02），而车报坐标是 WGS-84，
 * 叠加「geocode 本身偏 ~1.3km」+「坐标系偏 608m」两个误差，只能把半径放大到 1200m 兜底，
 * 结果在 1km 外就可能误报「到家」。改用车自己的采样点中位数（天然 WGS-84）后半径可回 300~500m。
 *
 * POST /api/geofence/recenter {"label":"家","days":14,"radius_m":400,"dry_run":false}
 */
async function apiGeofenceRecenter(env, request) {
  const body = await request.json().catch(() => ({}));
  const D1 = env.DB;
  const vehicle = await db.getVehicle(D1);
  if (!vehicle) return json({ error: "车辆未初始化" }, 400);

  const label = String(body.label || "家");
  const days = Number(body.days ?? 14);
  const dryRun = body.dry_run === true;

  const geos = await db.listGeofences(D1, vehicle.vin);
  const geo = geos.find((g) => g.label === label);
  if (!geo) return json({ error: `没有名为「${label}」的围栏` }, 404);

  const since = shanghaiDate(new Date(Date.now() - days * 86400000)) + " 00:00:00";
  const all = await db.listRecentPositions(D1, vehicle.vin, { since, limit: 4000 });
  // 只保留现有中心 5km 内的点（够宽松，不受 608m 坐标系偏差影响），排除出差/远行的路过点
  const near = all.filter((p) => haversineM({ lat: p.lat, lon: p.lon }, { lat: geo.lat, lon: geo.lon }) <= 5000);
  if (near.length < 20) {
    return json({ ok: false, error: `附近采样点太少（${near.length} 个，至少 20），先多跑几天再纠偏` }, 400);
  }

  const sum = clusterSummary(near);
  const radius = body.radius_m !== undefined ? Number(body.radius_m) : sum.radius_m;
  const latest = all[0] || null;

  if (!dryRun) {
    await db.updateGeofenceGeometry(D1, vehicle.vin, label, {
      lat: sum.center.lat,
      lon: sum.center.lon,
      radius_m: radius,
    });
  }

  return json({
    ok: true,
    dry_run: dryRun,
    label,
    samples: { total: all.length, near: near.length, days, since },
    before: { lat: geo.lat, lon: geo.lon, radius_m: geo.radius_m },
    after: { lat: round6(sum.center.lat), lon: round6(sum.center.lon), radius_m: radius },
    spread: { p50_m: sum.p50, p95_m: sum.p95, max_m: sum.max },
    latest_sample: latest
      ? {
          sampled_at: latest.sampled_at,
          dist_to_new_center_m: Math.round(
            haversineM(sum.center, { lat: latest.lat, lon: latest.lon }),
          ),
        }
      : null,
    rows: dryRun ? geos : await db.listGeofences(D1, vehicle.vin),
  });
}

/** GET /api/trips?limit=30 —— 行程列表（不含线路点，轻量） */
async function apiTrips(env, url) {
  const D1 = env.DB;
  const vehicle = await db.getVehicle(D1);
  if (!vehicle) return json({ rows: [] });
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 30)));
  return json({ rows: await db.listTripLogs(D1, vehicle.vin, limit) });
}

/** GET /api/trips/:id —— 单条行程（含 route_points，面板画图用） */
async function apiTripDetail(env, path) {
  const D1 = env.DB;
  const vehicle = await db.getVehicle(D1);
  if (!vehicle) return json({ error: "车辆未初始化" }, 400);
  const id = Number(path.replace("/api/trips/", ""));
  if (!Number.isFinite(id)) return json({ error: "id 不合法" }, 400);
  const row = await db.getTripLog(D1, vehicle.vin, id);
  if (!row) return json({ error: "没有这条行程" }, 404);
  let points = [];
  try { points = JSON.parse(row.route_points || "[]"); } catch { points = []; }
  return json({ ...row, route_points: points });
}

/**
 * POST /api/trips/:id/shot —— 重新生成某条行程的线路图截图（D-082 运维口子）
 * 用途：截图当时失败/样式改版后重生成；只写 R2 + 上传飞书拿 image_key，不推卡。
 */
/**
 * POST /api/trips/:id/push —— 重推某条行程卡（D-090）
 * 用途：修正历史口径、或截图/卡片发错后重发。不占定时任务幂等键。
 */
async function apiTripPush(env, path) {
  const id = Number(String(path).replace("/api/trips/", "").replace("/push", ""));
  if (!Number.isInteger(id) || id <= 0) return json({ ok: false, error: "bad trip id" }, 400);
  const vehicle = await db.getVehicle(env.DB);
  if (!vehicle || !vehicle.vin) return json({ ok: false, error: "车辆信息未初始化" }, 400);
  const trip = await db.getTripLog(env.DB, vehicle.vin, id);
  if (!trip) return json({ ok: false, error: `找不到行程 ${id}` }, 404);
  const logs = [];
  const log = (...a) => logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  const imageKey = await collectorTest.attachTripImage(env, env.DB, vehicle.vin, id, Number(trip.distance_km || 0), log);
  const card = await collectorTest.buildTripCardForPush(env, env.DB, vehicle.vin, trip, imageKey);
  const target = await db.getState(env.DB, "feishu:target");
  if (!target) return json({ ok: false, error: "未绑定飞书推送目标" }, 400);
  const res = await sendCard(env, target, card);
  return json({ ok: res && res.ok !== false, id, image_key: imageKey, distance_km: trip.distance_km, sent: res, logs });
}

async function apiTripShot(env, path) {
  const id = Number(String(path).replace("/api/trips/", "").replace("/shot", ""));
  if (!Number.isInteger(id) || id <= 0) return json({ ok: false, error: "bad trip id" }, 400);
  const vehicle = await db.getVehicle(env.DB);
  if (!vehicle || !vehicle.vin) return json({ ok: false, error: "车辆信息未初始化" }, 400);
  const trip = await db.getTripLog(env.DB, vehicle.vin, id);
  if (!trip) return json({ ok: false, error: `找不到行程 ${id}` }, 404);
  const logs = [];
  const log = (...a) => logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  const imageKey = await collectorTest.attachTripImage(env, env.DB, vehicle.vin, id, Number(trip.distance_km || 0), log);
  return json({ ok: Boolean(imageKey), id, image_key: imageKey, distance_km: trip.distance_km, logs });
}

/**
 * POST /api/trips/backfill { from, to, push? }
 * 从 signal_sample 回溯切出行程窗口，补 trip_log + 线路图（D-077 修 bug 后用来补历史）
 */
async function apiTripsBackfill(env, request) {
  const body = await request.json().catch(() => ({}));
  const D1 = env.DB;
  const vehicle = await db.getVehicle(D1);
  if (!vehicle) return json({ error: "车辆未初始化" }, 400);
  const from = String(body.from || "");
  const to = String(body.to || "");
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(to)) {
    return json({ error: "from / to 需要 'YYYY-MM-DD HH:MM:SS'" }, 400);
  }
  const logs = [];
  const out = await collectorTest.backfillTrips(env, D1, vehicle.vin, from, to, {
    push: body.push === true,
    log: (m) => logs.push(String(m)),
  });
  return json({ ok: true, ...out, logs });
}

/**
 * POST /api/trips/rebuild { from, to, distance_km?, elec_km?, engine_km? }
 * 给历史时间段补建线路（也用于验证/修数据）。会给 trip_log 建一行（若无），入口需带 API token。
 */
async function apiTripsRebuild(env, request) {
  const body = await request.json().catch(() => ({}));
  const D1 = env.DB;
  const vehicle = await db.getVehicle(D1);
  if (!vehicle) return json({ error: "车辆未初始化" }, 400);
  const from = String(body.from || "");
  const to = String(body.to || "");
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(to)) {
    return json({ error: "from / to 需要 'YYYY-MM-DD HH:MM:SS'" }, 400);
  }
  const rows = await db.listPositionsBetween(D1, vehicle.vin, from, to);
  if (!rows.length) return json({ error: "该时间段没有位置采样" }, 400);

  const id = await db.saveTripLog(D1, {
    vin: vehicle.vin,
    started_at: from,
    ended_at: to,
    distance_km: body.distance_km ?? null,
    duration_min: body.duration_min ?? null,
    elec_km: body.elec_km ?? null,
    engine_km: body.engine_km ?? null,
    start_lat: rows[0].lat, start_lon: rows[0].lon,
    end_lat: rows[rows.length - 1].lat, end_lon: rows[rows.length - 1].lon,
    created_at: shanghaiNow(),
  });
  // 原始采样点的累计直线距离：用来判断「规划里程」是否离谱（偏差过大说明途经点太稀/绕行）
  let rawKm = 0;
  for (let i = 1; i < rows.length; i++) {
    rawKm += haversineM(rows[i - 1], rows[i]) / 1000;
  }

  const t0 = { lat: rows[0].lat, lon: rows[0].lon };
  const t1 = { lat: rows[rows.length - 1].lat, lon: rows[rows.length - 1].lon };
  let route = null;
  try {
    route = await collectorTest.buildTripRoute(env, D1, vehicle.vin, id, from, to, t0, t1);
  } catch (err) {
    return json({ ok: false, id, error: err.message });
  }
  const saved = await db.getTripLog(D1, vehicle.vin, id);
  return json({
    ok: true, id, samples: rows.length, raw_km: round(rawKm, 2), route,
    row: saved ? { ...saved, route_points: (() => { try { return JSON.parse(saved.route_points || "[]").length; } catch { return 0; } })() } : null,
  });
}

function round6(v) {
  return Math.round(Number(v) * 1e6) / 1e6;
}

//  D-197：dry_run 只渲染不发送 —— 批量给仓库出卡片截图时不能刷屏用户的飞书
let DRY_PUSH = false;
let LAST_DRY_CARD = null;

let PUSH_ENV = null;
let PUSH_TARGET = null;

async function pushOrDry(card) {
  if (DRY_PUSH) {
    LAST_DRY_CARD = card;
    return { ok: true, code: 0, msg: "dry_run" };
  }
  return await sendCard(PUSH_ENV, PUSH_TARGET, card);
}

async function apiTestPush(env, request) {
  DRY_PUSH = false;
  LAST_DRY_CARD = null;
  try {
    DRY_PUSH = Boolean((await request.clone().json().catch(() => ({}))).dry_run);
  } catch { DRY_PUSH = false; }
  try {
    const res = await apiTestPushInner(env, request);
    if (DRY_PUSH && LAST_DRY_CARD && res && res.ok) {
      const j = await res.clone().json().catch(() => null);
      if (j) return json({ ...j, dry_run: true, card: LAST_DRY_CARD });
    }
    return res;
  } catch (err) {
    const msg = String(err && err.message || err);
    try {
      await env.DB.prepare(`
        INSERT INTO runtime_state (k, v, updated_at) VALUES ('last_error', ?, ?)
        ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at
      `).bind(JSON.stringify({ where: "test-push", message: msg, stack: String(err && err.stack || "").slice(0, 900) }), shanghaiNow()).run();
    } catch { /* ignore */ }
    return json({ ok: false, error: "internal", message: msg }, 500);
  } finally {
    DRY_PUSH = false;
  }
}

async function apiTestPushInner(env, request) {
  const D1 = env.DB;
  const target = await db.getState(D1, "feishu:target");
  if (!target) {
    return json({ ok: false, error: "尚未绑定推送目标：请先调用 POST /api/feishu/target，或在飞书里给机器人发一条消息" }, 400);
  }
  PUSH_ENV = env;
  PUSH_TARGET = target;
  const body = await request.json().catch(() => ({}));
  if (body.text) return json(await sendText(env, target, String(body.text)));
  const vehicle = await db.getVehicle(D1);
  const s = vehicle ? await db.lastSample(D1, vehicle.vin) : null;
  const trip = s?.trip_total_json ? safeJson(s.trip_total_json, null) : null;
  const detailState = await db.getState(D1, "last:detail", null);
  const health = vehicle ? await db.listHealth(D1, vehicle.vin) : [];
  const icons = await db.getState(D1, "card:icons", null);
  //  D-114：`POST /api/test-push {"kind":"daily","sample":{...}}` 用「真实日汇总 + 覆盖字段」渲染并按真发，
  //   用来验收极端组合（一天同时有智驾/充电/用油），不必等真实事件发生。
  if (body.kind === "daily" && vehicle) {
    const date = String(body.date || shanghaiDate(new Date(Date.now() - 24 * 3600 * 1000)));
    const row = await db.getDaily(D1, vehicle.vin, date);
    if (!row) return json({ ok: false, error: `${date} 没有日汇总` }, 400);
    const merged = { ...row, ...(body.sample || {}) };
    const up = await collectorTest.usagePrice(D1, vehicle.vin, `${date} 23:59:59`);
    const ne = await db.currentFuelPrice(D1);
    const card = cards.buildDailyCard({
      d: merged, vehicle, priceCny: body.price ?? up.price, fuelPriceCny: ne, dateLabel: date,
      priceNote: up.at ? `按 ${String(up.at).slice(5, 16)} 那次充电的电价` : null, icons,
    });
    const res = await pushOrDry(card);
    return json({ ok: res.ok, code: res.code, msg: res.msg, date, sample: body.sample || null });
  }
  //  D-131：`POST /api/test-push {"kind":"today","sample":{...}}` 用「今天真实累计 + 覆盖字段」渲染今日小结，
  //   用来验收「今天有充电」这类不一定当天发生的情况（今日卡正常不会推送，只能这样造）。
  if (body.kind === "today" && vehicle) {
    const date = String(body.date || shanghaiDate());
    const base = await commandsTest.partialDay(D1, vehicle.vin, date);
    if (!base) return json({ ok: false, error: `${date} 还没有采样数据` }, 400);
    const merged = { ...base, ...(body.sample || {}) };
    const card = commandsTest.partialDayCard(merged, await db.currentFuelPrice(D1), vehicle, icons);
    const res = await pushOrDry(card);
    return json({ ok: res.ok, code: res.code, msg: res.msg, date, sample: body.sample || null });
  }

  //  D-135：`POST /api/test-push {"kind":"charge","sample":{"phase":"start|end", ...}}` 造充电卡，
  //   真实充电事件一天最多一两次，验收只能靠模拟。
  if (body.kind === "charge") {
    const phase = body.phase === "start" ? "start" : "end";
    const sess = {
      started_at: "2026-11-13 09:12:00",
      ended_at: "2026-11-13 10:26:00",
      duration_min: 74,
      capacity_kwh: 32.5,
      charging_type: 1,
      avg_power_kw: 26.4,
      cost_cny: 22.75,
      price_per_kwh: 0.7,
      ...(body.session || {}),
    };
    const card = cards.buildChargeCard({
      session: sess, priceCny: body.price ?? 0.68, phase,
      vehicle, battery: body.battery ?? 41, range: body.range ?? 118, addedKm: body.addedKm ?? null, icons,
      noData: !!body.noData,
    });
    const res = await pushOrDry(card);
    return json({ ok: res.ok, code: res.code, msg: res.msg, phase });
  }

  //  D-141：`POST /api/test-push {"kind":"stop","stop":"home|parked","useLastParkPhotos":true}`
  //   造到家 / 车辆已停好卡；照片可复用上一次真实泊车的 4 张 img_key，便于验收排版。
  if (body.kind === "trip" && vehicle) {
    const rows = await db.listTripLogs(D1, vehicle.vin, 1);
    if (!rows.length) return json({ ok: false, error: "还没有行程记录" }, 400);
    const t = { ...rows[0], ...(body.trip || {}) };
    let imgKey = body.imgKey || null;
    let shotInfo = null;
    if (body.withImage) {
      //  D-166：现场重截一张，验证「底图黑屏」是否修好（不消耗推送次数，只烧浏览器额度）
      try {
        imgKey = await collectorTest.attachTripImage(env, D1, vehicle.vin, t.id, Number(t.distance_km) || 0);
        shotInfo = { ok: Boolean(imgKey) };
      } catch (e) {
        shotInfo = { ok: false, msg: String(e?.message || e).slice(0, 160) };
      }
    }
    const card = await collectorTest.buildTripCardForPush(env, D1, vehicle.vin, t, imgKey);
    const res = await pushOrDry(card);
    return json({ ok: res.ok, code: res.code, msg: res.msg, card, shotInfo });
  }

  if (body.kind === "stop" || body.kind === "geo") {
    const wants = body.stop || body.direction || null;
    const kind = wants === "out" ? "out" : (wants === "parked" ? "parked" : "home");
    if (kind === "out") {
      const card = cards.buildDepartureCard({
        at: body.at || "2026-11-13 08:09:00",
        battery: body.battery ?? 62, range: body.range ?? 158, label: body.label || "家",
        //  预览给一个像样的「在家停留」（真实链路由围栏进入时刻算出，见 collector）
        homeSince: body.homeSince || "2026-11-12 20:49:00",
        fuelLevel: body.fuelLevel ?? 18, vehicle, icons,
      });
      const res = await pushOrDry(card);
      return json({ ok: res.ok, code: res.code, msg: res.msg, kind: "out" });
    }
    let images = Array.isArray(body.images) ? body.images : [];
    if (!images.length && (body.useLastParkPhotos ?? true)) {
      const last = await db.getState(D1, `park:last:${vehicle?.vin}`, null);
      images = Array.isArray(last?.keys) ? last.keys : [];
    }
    //  预览卡的哨兵/锁车默认取真实缓存（last:detail），不要写死——
    //  2026-11-19 就因为这里写死 "已关闭"，让用户以为「哨兵明明开着却显示关闭」（D-176）
    const realDetail = await db.getState(D1, "last:detail", null);
    const card = cards.buildStopCard({
      kind, at: body.at || (kind === "home" ? "2026-11-13 18:12:00" : "2026-11-13 15:32:00"),
      battery: body.battery ?? (kind === "home" ? 62 : 71),
      range: body.range ?? (kind === "home" ? 158 : 182),
      sentinelText: body.sentinelText ?? (realDetail?.sentinel_text ?? null),
      locked: body.locked ?? (realDetail?.locked ?? null),
      place: body.place ?? "示例街道示例大道示例苑",
      distanceM: body.distanceM ?? 18, label: body.label || "家",
      images, vehicle, icons,
    });
    const res = await pushOrDry(card);
    return json({ ok: res.ok, code: res.code, msg: res.msg, kind, photos: images.length });
  }

  //  D-165：`POST /api/test-push {"kind":"maint"}` 用真实保养台账造保养提醒卡
  if (body.kind === "maint") {
    const detail = (await db.getState(D1, "last:detail", null)) || {};
    const maint = detail.maint || {};
    const LIST = [
      ["enginelevel1", "增程器机油"], ["enginelevel2", "增程器机滤"], ["acfilter", "空调滤芯"],
      ["sparkplug", "火花塞"], ["coolfuild", "冷却液"], ["gearbrakeoil", "齿轮/刹车油"],
    ];
    const items = LIST.map(([k, label]) => {
      const it = maint[k];
      if (!it || it.left == null) return null;
      //  D-169：把到期日 / 上次保养也透传，否则预览卡显示不出「到期日期」与「N 天后到期」
      return {
        key: k, label, left: Math.round(it.left), period: it.period ?? null, byEngine: !!it.byEngine,
        name: it.name || null, due: it.due || null, lastAt: it.lastAt || null, lastKm: it.lastKm ?? null,
      };
    }).filter(Boolean);
    const warnKm = body.warnKm ?? 1500;
    const hits = items.filter((it) => it.left <= warnKm)
      .map((it) => ({ ...it, level: it.left <= 500 ? "crit" : "warn" }));
    const card = cards.buildMaintReminderCard({
      items, hits, at: body.at || shanghaiNow(), vehicle,
      icons: await db.getState(D1, "card:icons", null),
    });
    const res = await pushOrDry(card);
    return json({ ok: res.ok, code: res.code, msg: res.msg, kind: "maint", items: items.length, hits: hits.length });
  }

  //  D-144：`POST /api/test-push {"kind":"fuel"}` 造加油卡（真实加油一个月两三次，只能模拟）
  if (body.kind === "energy") {
    //  预览能量提醒卡（不写 push_log，不影响每天一次的频控）
    const preset = body.case || "batt";
    const battItem = { label: "电量偏低", short: "12% · 续航 40 km", value: "12% · 纯电续航 40 km（阈值 15%）", pct: 12, rangeKm: 40 };
    const fuelItem = { label: "油量偏低", short: "8% · 续航 92 km", value: "8% · 综合续航 92 km（阈值 10%）", pct: 8, rangeKm: 92 };
    const items = body.items || (preset === "fuel" ? [fuelItem] : preset === "both" ? [battItem, fuelItem] : [battItem]);
    let prevCharge = null;
    let prevFuel = null;
    try {
      const cs = await db.listChargeSessions(D1, vehicle.vin, 1);
      prevCharge = cs[0] ? cs[0].ended_at || cs[0].started_at : null;
      const fl = await db.lastFuelLog(D1, vehicle.vin);
      prevFuel = fl ? fl.ended_at || fl.started_at : null;
    } catch {}
    const card = cards.buildEnergyCard({
      items, at: body.at || shanghaiNow(), vehicle, icons: await db.getState(D1, "card:icons", null),
      lastChargeAt: body.lastChargeAt ?? prevCharge, lastFuelAt: body.lastFuelAt ?? prevFuel,
    });
    const res = await pushOrDry(card);
    return json({ ok: res.ok, code: res.code, msg: res.msg, kind: "energy", bytes: JSON.stringify(card).length });
  }
  if (body.kind === "anomaly") {
    //  预览车辆异常卡（不写 push_log，不影响每天一次的频控）
    const tireItem = { label: "胎压偏低", short: "左前 189 kPa", value: "左前 189 kPa（标准 2.1~2.5 bar）" };
    const plugItem = { label: "插枪未充电", short: "插枪 32 分钟无功率", value: "已插枪 32 分钟仍无功率（非预约充电）" };
    const items = body.items || (body.case === "two" ? [tireItem, plugItem] : [tireItem]);
    const card = cards.buildAnomalyCard({ items, at: body.at || shanghaiNow(), vehicle, icons: await db.getState(D1, "card:icons", null) });
    const res = await pushOrDry(card);
    return json({ ok: res.ok, code: res.code, msg: res.msg, kind: "anomaly", bytes: JSON.stringify(card).length });
  }
  if (body.kind === "advice") {
    //  F-11 D-177：预览充电电价卡（不写 push_log，不占用每天一次的频控）。
    //  电价表默认读线上真实分时表，别再写死一张假表——预览看起来「对」，线上反而错，代价更大。
    const realTiers = await db.listElecTiers(D1);
    const card = cards.buildChargeAdviceCard({
      battery: body.battery ?? 26, rangeKm: body.rangeKm ?? 88,
      nowPrice: body.nowPrice ?? 0.90, valleyPrice: body.valleyPrice ?? 0.68,
      valleyWindow: body.valleyWindow || "01:00~05:00",
      needKwh: body.needKwh ?? 16.7, saveCny: body.saveCny ?? 3.67,
      tiers: body.tiers || realTiers,
      nowHHMM: body.nowHHMM || shanghaiNow().slice(11, 16),
      vehicle, icons: await db.getState(D1, "card:icons", null), at: body.at || shanghaiNow(),
    });
    const res = await pushOrDry(card);
    return json({ ok: res.ok, code: res.code, msg: res.msg, kind: "advice", bytes: JSON.stringify(card).length });
  }
  if (body.kind === "cred") {
    //  F-18：预览凭据告警卡（不写 rem:cred，不影响真实去重）
    const level = body.level || "critical";
    const card = cards.buildCredCard({
      level,
      daysLeft: body.days ?? 2.7,
      expiresText: body.expires || "2026-11-28 10:11:37",
      at: body.at || shanghaiNow(),
      vehicle,
      icons: await db.getState(D1, "card:icons", null),
    });
    const res = await pushOrDry(card);
    return json({ ok: res.ok, code: res.code, msg: res.msg, kind: "cred", level, bytes: JSON.stringify(card).length });
  }
  if (body.kind === "fault") {
    //  预览充电异常卡（不写 rem:fault，不污染真实去重）
    const hits = body.hits || [
      { path: "Vehicle.Powertrain.Battery.ChargeFaults", label: "充电故障码", code: body.code ?? 3 },
      { path: "Vehicle.Powertrain.Battery.EVESFltStopChrg", label: "充电中止标志", code: body.stopped ?? 1 },
    ];
    const card = cards.buildChargeFaultCard({
      at: body.at || shanghaiNow(), battery: body.battery ?? 88, vehicle,
      icons: await db.getState(D1, "card:icons", null),
    });
    const res = await pushOrDry(card);
    return json({ ok: res.ok, code: res.code, msg: res.msg, kind: "fault", bytes: JSON.stringify(card).length });
  }
  if (body.kind === "ota") {
    //  预览 OTA 已升级卡（不写 rem:ota）
    const card = cards.buildOtaCard({
      before: body.before || "8.6.0-1.55.253",
      after: body.after || "8.7.0-1.56.286",
      at: body.at || shanghaiNow(),
      vehicle,
      icons: await db.getState(D1, "card:icons", null),
    });
    const res = await pushOrDry(card);
    return json({ ok: res.ok, code: res.code, msg: res.msg, kind: "ota", bytes: JSON.stringify(card).length });
  }
  if (body.kind === "drain") {
    //  预览停车掉电卡（不写 rem:park，不污染真实节奏）
    const card = cards.buildDrainCard({
      from: body.from ?? 92, to: body.to ?? 90,
      hours: body.hours ?? 4.2, perHour: body.perHour ?? 0.48,
      since: body.since || "2026-11-19 09:12:00",
      at: body.at || shanghaiNow(),
      sentinelText: body.sentinelText ?? "开启",
      vehicle,
      icons: await db.getState(D1, "card:icons", null),
    });
    const res = await pushOrDry(card);
    return json({ ok: res.ok, code: res.code, msg: res.msg, kind: "drain", bytes: JSON.stringify(card).length });
  }
  //  D-185：预览口漏了 menu / switch 两种 kind，`{"kind":"menu"}` 一路落到下面的
  //   状态卡默认分支，于是「要菜单卡却收到车辆状态卡」。这里补齐，并让未知 kind 直接报错。
  if (body.kind === "menu") {
    const card = cards.buildMenuCard({ groups: MENU_GROUPS, buttons: MENU_BUTTONS, vehicle });
    const res = await pushOrDry(card);
    return json({ ok: res.ok, code: res.code, msg: res.msg, kind: "menu", bytes: JSON.stringify(card).length });
  }
  if (body.kind === "switch" || body.kind === "pushswitch") {
    const cur = await getSwitches(D1);
    const card = cards.buildSwitchCard({ switches: cur, kinds: SWITCH_KINDS, labels: SWITCH_LABELS, vehicle });
    const res = await pushOrDry(card);
    return json({ ok: res.ok, code: res.code, msg: res.msg, kind: "switch" });
  }

  if (body.kind === "fuel") {
    const event = {
      started_at: "2026-11-14 08:42:00", ended_at: "2026-11-14 08:46:00",
      from: 18, to: 78, liters: 36.2, tank_l: 60, at: "2026-11-14 08:44:00",
      ...(body.event || {}),
    };
    const rangeFuel = body.rangeFuel ?? 205;
    // 预览卡也用真实历史价（D-182）：以前写死 9.49/11-09，会让人误以为系统记错了油价
    const realFuelRow = await db.currentFuelPriceRow(D1);
    const card = cards.buildFuelCard({
      event, priceCny: body.price ?? null,
      lastPriceCny: body.lastPrice ?? realFuelRow?.price_cny ?? null,
      lastPriceAt: body.lastPriceAt ?? realFuelRow?.effective_from ?? null,
      rangeFuel, vehicle, icons, done: !!body.done,
    });
    const res = await pushOrDry(card);
    // 测试口也要登记 pending，否则卡内 form 提交找不到「本次加油」（2026-11-14 踩坑）
    if (res.ok && !body.done) {
      await db.setState(D1, "fuel:pending_price", {
        at: event.at || event.ended_at, liters: event.liters, delta_pct: event.to - event.from,
        created_at: shanghaiNow(), message_id: res?.data?.message_id || null,
        started_at: event.started_at, ended_at: event.ended_at,
        from: event.from, to: event.to, range_fuel: rangeFuel,
        last_price: body.lastPrice ?? 9.49, test: true,
      });
    }
    return json({ ok: res.ok, code: res.code, msg: res.msg, message_id: res?.data?.message_id || null });
  }

  //  D-119：`{"sample":{...}}` 覆盖状态卡字段（顶层字段合并进 s，detail 里的键合并进 detail），
  //   用于验收极端组合（充电中 + 哨兵开 → 绿/红标签），不必等真实状态发生。
  //  D-185：带 kind 却是未知枚举时直接报错——静默回落状态卡会让人以为「推送成功」，
  //   排查时又多一层误导（本次「要菜单卡收到状态卡」就是这么来的）。
  const KNOWN_KINDS = ["status", "daily", "today", "charge", "trip", "stop", "geo", "maint",
    "energy", "anomaly", "advice", "cred", "fault", "ota", "drain", "fuel", "menu", "switch", "pushswitch"];
  if (body.kind && !KNOWN_KINDS.includes(body.kind)) {
    return json({ ok: false, msg: `未知的 kind：${body.kind}`, known: KNOWN_KINDS }, 400);
  }

  const sample = body.sample && typeof body.sample === "object" ? body.sample : null;
  const baseS = s ? { ...s, detail: detailState || buildDetail(safeJson(s.payload, {})) } : {};
  const mergedS = sample
    ? {
        ...baseS,
        ...Object.fromEntries(Object.entries(sample).filter(([k]) => k !== "detail")),
        detail: { ...(baseS.detail || {}), ...(sample.detail || {}) },
      }
    : baseS;
  const card = cards.buildStatusCard({
    s: mergedS,
    trip: tripView(trip),
    vehicle: vehicle || {}, health, icons,
  });
  const res = await pushOrDry(card);
  return json({ ok: res.ok, code: res.code, msg: res.msg });
}

/**
 * 推送预览：立即生成并发送某种报表（绕过定时门控与幂等，便于验收）
 *   POST /api/push-preview?kind=daily|weekly|monthly
 */
async function apiPushPreview(env, url) {
  const D1 = env.DB;
  const kind = url.searchParams.get("kind") || "daily";
  const vehicle = await db.getVehicle(D1);
  if (!vehicle) return json({ error: "no vehicle" }, 404);
  const target = await db.getState(D1, "feishu:target");
  if (!target) return json({ error: "未绑定飞书目标" }, 400);
  const vin = vehicle.vin;
  const price = await db.currentPrice(D1);
  const fuelPrice = await db.currentFuelPrice(D1);
  const now = new Date();

  let card = null;
  let label = "";
  if (kind === "daily") {
    const y = shanghaiDate(new Date(now.getTime() - 24 * 3600 * 1000));
    const row = await db.getDaily(D1, vin, y);
    if (!row) return json({ error: `没有 ${y} 的日数据` }, 400);
    card = cards.buildDailyCard({
      d: row, vehicle, priceCny: price, fuelPriceCny: fuelPrice, dateLabel: y,
      icons: await db.getState(D1, "card:icons", null),
    });
    label = y;
  } else if (kind === "weekly") {
    const { from, to } = lastWeekRange(now);
    const rows = await db.listDaily(D1, vin, from, to);
    if (!rows.length) return json({ error: `没有 ${from}~${to} 的数据` }, 400);
    const up = await collectorTest.usagePrice(D1, vin, `${to} 23:59:59`);
    const prevRows = await db.listDaily(D1, vin, addDaysStr(from, -7), addDaysStr(from, -1));
    card = cards.buildWeeklyCard({
      summary: summarizeRows(rows), days: rows, weekLabel: `${from} ~ ${to}`, highlights: highlightsRows(rows),
      energy: energyAggregate(rows), prev: energyAggregate(prevRows),
      vehicle, priceCny: up.price, icons: await db.getState(D1, "card:icons", null),
    });
    label = `${from}~${to}`;
  } else if (kind === "monthly") {
    const { from, to, month } = lastMonthRange(now);
    const rows = await db.listDaily(D1, vin, from, to);
    if (!rows.length) return json({ error: `没有 ${month} 的数据` }, 400);
    const pmRange = monthRangeOf(monthBefore(month));
    const pmRows = await db.listDaily(D1, vin, pmRange.from, pmRange.to);
    const upM = await collectorTest.usagePrice(D1, vin, `${to} 23:59:59`);
    card = cards.buildMonthlyCard({
      summary: summarizeRows(rows), days: rows, monthLabel: month, highlights: highlightsRows(rows),
      vehicle, priceCny: upM.price, icons: await db.getState(D1, "card:icons", null),
      prev: summarizeRows(pmRows), title: "上月用车小结",
    });
    label = month;
  } else {
    return json({ error: "kind 只能是 daily|weekly|monthly" }, 400);
  }
  const res = await sendCard(env, target, card);
  return json({ ok: res.ok, code: res.code, msg: res.msg, kind, label });
}
