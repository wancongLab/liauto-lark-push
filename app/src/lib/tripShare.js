/**
 * 行程分享令牌（D-079）
 *
 * 为什么需要它：
 *   飞书卡片里的「查看线路图」原来指向 `https://car.example.com/?trip=7` ——
 *   那是**面板**地址，需要 `li_token` cookie。手机上从飞书内置浏览器点开时没有 cookie，
 *   面板 API 返 401 → `public/app.js:24` 跳 `/login` → 页面显示 "bad token"（用户实测）。
 *
 * 为什么不能把 API_TOKEN 直接拼进链接：
 *   API_TOKEN 是面板的**全权凭证**（能看 VIN / 车牌 / 所有行程 / 触发推送）。
 *   链接一旦被转发（飞书里很容易），等于把整车数据送人 —— 用户明确说这是安全底线。
 *
 * 所以：给**单条行程**签一个短令牌。
 *   - 内容只有 `tripId` 与过期时刻，签名用 HMAC-SHA256(secret, `${tripId}.${exp}`)
 *   - 页面只渲染这一条行程（无 VIN / 车牌 / 其他行程 / 面板入口）
 *   - 有效期默认 **365 天**（可用 `env.TRIP_LINK_TTL_DAYS` 覆盖，D-080）：
 *     用户实测「链接能打开，但 14 天后就看不到历史轨迹了」——行程卡会一直躺在飞书聊天记录里，
 *     一年内点开都还能看；真正永久归档在面板（`li_token` cookie 有效期同样是 1 年）。
 *   - secret 优先 `env.TRIP_SHARE_SECRET`，否则用 `env.API_TOKEN` 派生
 *   - 校验用定长比较，避免计时侧信道（虽然威胁模型很弱，但便宜）
 */
const enc = new TextEncoder();

export const TRIP_LINK_TTL_DAYS_DEFAULT = 365;
export const TRIP_TOKEN_TTL_SEC = TRIP_LINK_TTL_DAYS_DEFAULT * 24 * 3600;

/** 链接有效期（秒）：优先 env.TRIP_LINK_TTL_DAYS，非法值回退默认 365 天 */
export function ttlSecFromEnv(env) {
  const days = Number(env && env.TRIP_LINK_TTL_DAYS);
  if (!Number.isFinite(days) || days <= 0) return TRIP_TOKEN_TTL_SEC;
  return Math.min(Math.round(days * 24 * 3600), 10 * 365 * 24 * 3600);
}

async function hmacKey(env) {
  const secret = (env && (env.TRIP_SHARE_SECRET || env.API_TOKEN)) || "liauto-lark-push-dev-secret";
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

function b64url(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sigOf(env, payload) {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env), enc.encode(payload));
  return b64url(sig).slice(0, 32);   // 32 个 base64url 字符 ≈ 192 bit，够用且链接短
}

export async function signTripToken(env, tripId, ttlSec = ttlSecFromEnv(env), nowSec = Math.floor(Date.now() / 1000)) {
  const id = Number(tripId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("bad tripId");
  const exp = nowSec + ttlSec;
  const sig = await sigOf(env, `${id}.${exp}`);
  return `${id}.${exp}.${sig}`;
}

export async function verifyTripToken(env, token, nowSec = Math.floor(Date.now() / 1000)) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const id = Number(parts[0]);
  const exp = Number(parts[1]);
  const sig = parts[2];
  if (!Number.isInteger(id) || id <= 0) return null;
  if (!Number.isFinite(exp) || exp < nowSec) return null;
  const want = await sigOf(env, `${id}.${exp}`);
  if (sig.length !== want.length) return null;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= sig.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0 ? { id, exp } : null;
}

export const __test = { signTripToken, verifyTripToken, b64url, ttlSecFromEnv };
