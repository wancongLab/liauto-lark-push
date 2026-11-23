/**
 * 泊车照片（SVM）—— D-092/D-093
 *
 * 链路（2026-11-05 实测）：
 *   VSS `Vehicle.360Svm.Park.Filekey`（JSON 字符串）
 *     → { picTime, fileKeys: { picInFront/Rear/Left/Right/Top } }
 *     → GET /chehejia-service-ois-app/ois/file/service/urls?fileKeys=…&identify=vehicle
 *     → 签名直链（bcebos，有效期 24 小时）
 *     → 下载 5 张（每张 120~200 KB）→ 上传飞书拿 image_key → 组卡
 *
 *  不落 R2 / 不落 D1：用户明确要求「发到飞书就行，服务端不留存」。
 *   签名 URL 与图片只在本次请求内存里活一遍。
 */

const OIS_PATH = "/chehejia-service-ois-app/ois/file/service/urls";
export const PARK_ANGLES = [
  ["picInFront", "车头", "前"],
  ["picInRear", "车尾", "后"],
  ["picInLeft", "左侧", "左"],
  ["picInRight", "右侧", "右"],
];

/** 从 VSS 的 Filekey 值里解出 picTime + fileKeys；解析失败返回 null */
export function parseParkFilekey(raw) {
  if (!raw) return null;
  let obj = raw;
  if (typeof raw === "string") {
    try { obj = JSON.parse(raw); } catch { return null; }
  }
  if (!obj || typeof obj !== "object") return null;
  const fk = obj.fileKeys;
  if (!fk || typeof fk !== "object") return null;
  const keys = {};
  for (const [k, v] of Object.entries(fk)) if (typeof v === "string" && v) keys[k] = v;
  if (!Object.keys(keys).length) return null;
  return { picTime: obj.picTime || String(obj.picTimestamp || ""), fileKeys: keys };
}

/** fileKeys → 签名 URL 映射（{ fileKey: url }） */
export async function signedUrls(client, fileKeys) {
  const keys = Array.isArray(fileKeys) ? fileKeys : Object.values(fileKeys || {});
  if (!keys.length) return {};
  const q = encodeURIComponent(keys.join(","));
  const r = await client.travel(`${OIS_PATH}?fileKeys=${q}&identify=vehicle`);
  const code = r?.code;
  if (code !== undefined && code !== 0) {
    throw new Error(`换签名 URL 失败: code=${code} ${r?.message || r?.msg || ""}`.trim());
  }
  const data = r?.data;
  if (!data) return {};
  if (Array.isArray(data)) {
    const out = {};
    for (const it of data) if (it?.url) out[it.fileKey || it.key || ""] = it.url;
    return out;
  }
  return data;
}

/** 下载图片字节（只允许 https） */
export async function downloadImage(url, timeoutMs = 20000) {
  if (!/^https:\/\//i.test(String(url || ""))) throw new Error("非法图片地址");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`下载图片失败: HTTP ${r.status}`);
    const buf = new Uint8Array(await r.arrayBuffer());
    // JPEG 魔数 FF D8 FF —— 防止把错误页当图片发给飞书（D-082 同类坑）
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) {
      throw new Error(`下载到的不是 JPEG（${buf.length} 字节）`);
    }
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

export const __test = { parseParkFilekey, signedUrls, downloadImage, PARK_ANGLES };
