/**
 * 飞书 Open API 客户端（应用身份）
 *
 * 用 `tenant_access_token` 以应用身份发消息：
 *   POST /open-apis/auth/v3/tenant_access_token/internal   （取 token，2h 有效）
 *   POST /open-apis/im/v1/messages?receive_id_type=<type>  （发消息 / 交互卡片）
 *
 *  需要在飞书开发者后台开通权限：`im:message:send_as_bot`（或 im:message / im:message:send），
 *   开通后**必须发布版本**才生效。
 *
 *  目标（receive_id）有两种：
 *   · open_id  —— 通过【事件订阅】收到用户消息时自动捕获（推荐）
 *   · chat_id  —— 用户复制飞书会话链接，从 `oc_xxx` 解析（零配置路径）
 */

import * as db from "./db.js";
import { stripCharts } from "./cards.js";
import { createHash, createHmac, createDecipheriv, timingSafeEqual, randomBytes } from "node:crypto";

const API = "https://open.feishu.cn/open-apis";

/** 取 tenant_access_token（缓存在 D1，TTL 7000s） */
export async function getTenantToken(env) {
  const key = "feishu:token";
  const cached = await db.getState(env.DB, key);
  if (cached?.token && Number(cached.exp) > Date.now()) return cached.token;

  const res = await fetch(`${API}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
  });
  const body = await res.json();
  if (body.code !== 0 || !body.tenant_access_token) {
    throw new Error(`取 tenant_access_token 失败: code=${body.code} msg=${body.msg}`);
  }
  await db.setState(env.DB, key, { token: body.tenant_access_token, exp: Date.now() + 7000 * 1000 });
  return body.tenant_access_token;
}

/**
 * 解析用户给的目标：飞书会话链接 / chat_id / open_id
 *  - https://applink.feishu.cn/client/chat/oc_xxxx  → chat_id
 *  - https://xxx.feishu.cn/client/chat/oc_xxxx      → chat_id
 *  - oc_xxxx → chat_id
 *  - ou_xxxx → open_id
 */
export function resolveTarget(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  const m = raw.match(/\b(oc_[a-zA-Z0-9_-]+)/);
  if (m) return { type: "chat_id", id: m[1] };
  const m2 = raw.match(/\b(ou_[a-zA-Z0-9_-]+)/);
  if (m2) return { type: "open_id", id: m2[1] };
  return null;
}

/** 发消息（msg_type: text / interactive / post …） */
/**
 * 上传图片（D-082：行程线路图内嵌卡片）
 *   POST /open-apis/im/v1/images  multipart: image_type=message, image=<file>
 * 返回 image_key（形如 img_v2_xxx），卡片里用 {tag:"img", img_key} 引用。
 * 需要权限 `im:resource`（上传图片/文件）——与发消息的 im:message 是两个权限。
 */
export async function uploadImage(env, bytes, mime = "image/png", filename = "trip.png") {
  const token = await getTenantToken(env);
  const form = new FormData();
  form.append("image_type", "message");
  form.append("image", new Blob([bytes], { type: mime }), filename);
  const res = await fetch(`${API}/im/v1/images`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const body = await res.json().catch(() => ({}));
  const key = body && body.data && body.data.image_key;
  if (body.code !== 0 || !key) {
    throw new Error(`上传图片失败: code=${body.code} msg=${body.msg || res.status}`);
  }
  return key;
}

export async function sendMessage(env, target, msgType, content) {
  //  开源版：没配飞书应用就是「合法的空跑」——别把整条采集链路打成 error。
  //  示例模式（VEHICLE_PROVIDER=sample）默认就是这种情况：卡片能生成，只是发不出去。
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) {
    return { ok: false, code: -1, msg: "未配置飞书应用（FEISHU_APP_ID / FEISHU_APP_SECRET），跳过发送" };
  }
  const token = await getTenantToken(env);
  const res = await fetch(`${API}/im/v1/messages?receive_id_type=${target.type}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ receive_id: target.id, msg_type: msgType, content: JSON.stringify(content) }),
  });
  const body = await res.json();
  return { ok: body.code === 0, code: body.code, msg: body.msg, data: body.data, raw: body };
}

/** 发交互卡片（Card 2.0：content 直接是卡片对象） */
export async function sendCard(env, target, card) {
  const res = await sendMessage(env, target, "interactive", card);
  if (res.ok) return res;
  // 卡片被飞书拒绝（常见于 chart 元素语法）→ 去掉图表重发一次，保证信息能送达
  const isCardParseError = /parse card json|unknown property|ErrCode: 200621/i.test(res.msg || "");
  if (!isCardParseError) return res;
  const stripped = stripCharts(card);
  console.warn("[feishu] 卡片含非法元素，去掉图表后重发:", res.msg?.slice(0, 120));
  const retry = await sendMessage(env, target, "interactive", stripped);
  return { ...retry, degraded: true, originalError: res.msg };
}

/**
 * 更新已发送的卡片（D-145：加油卡填完油价后原地更新，不再追加消息）
 *   PATCH /open-apis/im/v1/messages/:message_id  body {content: <card json 字符串>}
 * 只能更新本应用自己发的消息；失败时调用方退回发纯文本。
 */
export async function updateCard(env, messageId, card) {
  const token = await getTenantToken(env);
  const res = await fetch(`${API}/im/v1/messages/${messageId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ content: JSON.stringify(card) }),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: body.code === 0, code: body.code, msg: body.msg, raw: body };
}

/** 发纯文本 */
export async function sendText(env, target, text) {
  return sendMessage(env, target, "text", { text });
}

/** 事件回调：URL 验证 */
export function verifyChallenge(body) {
  if (body?.type === "url_verification" && body?.challenge) {
    return new Response(JSON.stringify({ challenge: body.challenge }), {
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}

/**
 * 自动发现推送目标：列出机器人所在的群，取第一个作为 chat_id。
 *
 *  为什么需要它：飞书的 `im.message.receive_v1` 事件依赖「请求地址」事件订阅，
 *   配置繁琐且易漏发布；而把机器人拉进任意一个群后，
 *   `GET /im/v1/chats` 就能直接拿到 chat_id —— **完全不需要事件订阅、不需要额外权限**。
 *
 * 返回 {type:'chat_id', id, name} 或 null
 */
export async function discoverChat(env) {
  const token = await getTenantToken(env);
  const res = await fetch(`${API}/im/v1/chats?page_size=50`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  if (body.code !== 0) return { error: `code=${body.code} ${body.msg || ""}` };
  const items = body?.data?.items || [];
  if (!items.length) return null;
  const it = items[0];
  return { type: "chat_id", id: it.chat_id, name: it.name || "", member_count: it.member_count ?? null };
}

/**
 * 飞书回调验签（可选）
 *
 * 官方文档：signature = SHA256(timestamp + nonce + encryptKey + rawBody)
 * 头：X-Lark-Request-Timestamp / X-Lark-Request-Nonce / X-Lark-Signature
 *
 *  若在后台开启了「签名验证」但未配置 Encrypt Key，这里会跳过校验（只打警告）。
 */
export function verifySignature(headers, rawBody, encryptKey) {
  if (!encryptKey) return { ok: true, skipped: true };
  const ts = headers.get("X-Lark-Request-Timestamp") || "";
  const nonce = headers.get("X-Lark-Request-Nonce") || "";
  const sig = headers.get("X-Lark-Signature") || "";
  if (!ts || !nonce || !sig) return { ok: false, error: "缺少签名头" };
  const expect = createHash("sha256")
    .update(ts + nonce + encryptKey + rawBody, "utf8").digest("hex");
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expect, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, error: "签名不匹配" };
  return { ok: true };
}

/**
 * 解密「加密事件」
 *
 * 飞书加密格式：body.encrypt（base64）
 *   → AES-256-CBC 解密，key = SHA256(encryptKey)，IV = 密文前 16 字节
 *   → 明文 = random(16) + len(4, network order) + msg + appId
 */
export function decryptEvent(encryptB64, encryptKey) {
  const key = createHash("sha256").update(encryptKey, "utf8").digest();
  const data = Buffer.from(encryptB64, "base64");
  const iv = data.subarray(0, 16);
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  let plain = Buffer.concat([decipher.update(data.subarray(16)), decipher.final()]);
  const len = plain.readUInt32BE(16);
  const msg = plain.subarray(20, 20 + len).toString("utf8");
  return JSON.parse(msg);
}
