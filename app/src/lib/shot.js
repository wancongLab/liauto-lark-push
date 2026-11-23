/**
 * 行程线路图截图 —— Cloudflare Browser Rendering（Workers Binding，D-082）
 *
 * 为什么用 Browser Rendering 而不是自己画 PNG：
 *   · 账号是 **Workers Free**：CPU 10 ms/请求。640×420 的 SVG→PNG（resvg-wasm）
 *     约 50~200 ms CPU，必触发 1102。截图跑在 Cloudflare 的浏览器里，Worker 只发一个
 *     HTTP 请求，**等待网络不计 CPU** → Free 上可行。
 *   · Free 额度：浏览器时长 10 分钟/天、并发 3。本项目 3~5 张/天 × 2~4 s ≈ 15 s/天（2.5%）。
 *
 * 绑定方式（wrangler.jsonc，无需 API Token）：
 *   "browser": { "binding": "BROWSER" }
 * 要求 compatibility_date >= 2026-03-24（本项目 2026-10-27 ）。
 *
 * 就绪约定：分享页在底图 load/error 后给 <html> 加 .ready（3 s 兜底），这里用
 * waitForSelector 等它 —— 比 waitUntil:"networkidle0" 更快也更稳。
 */

export const SHOT_WIDTH = 640;
export const SHOT_HEIGHT = 420;
export const SHOT_SCALE = 2;
/** 行程短于这个里程不值得消耗浏览器额度 */
export const SHOT_MIN_KM = 3;
/** 每天最多截几张（护栏：异常情况下不烧穿 10 分钟/天） */
export const SHOT_DAILY_CAP = 8;

export function hasBrowser(env) {
  return Boolean(env && env.BROWSER && typeof env.BROWSER.quickAction === "function");
}

/**
 * 截一张图，返回 { bytes, contentType, browserMs }。
 * 失败抛错（调用方负责降级成纯文字卡）。
 */
export async function screenshotPage(env, url, opts = {}) {
  if (!hasBrowser(env)) throw new Error("未绑定 BROWSER（Browser Rendering）");

  const width = Math.round(opts.width || SHOT_WIDTH);
  const height = Math.round(opts.height || SHOT_HEIGHT);
  const scale = opts.scale || SHOT_SCALE;

  const res = await env.BROWSER.quickAction("screenshot", {
    url,
    viewport: { width, height, deviceScaleFactor: scale },
    gotoOptions: { waitUntil: "domcontentloaded", timeout: 20000 },
    waitForSelector: { selector: "html.ready", timeout: 15000 },
    screenshotOptions: { type: "png", fullPage: false, omitBackground: false },
  });

  if (!res || !res.ok) {
    const detail = res ? `${res.status} ${await res.text().catch(() => "")}`.slice(0, 300) : "no response";
    throw new Error(`截图失败: ${detail}`);
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!bytes.length) throw new Error("截图失败: 空响应");
  // PNG 魔数校验，避免把 JSON 错误页当图片上传
  if (!(bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)) {
    throw new Error("截图失败: 响应不是 PNG");
  }

  return {
    bytes,
    contentType: "image/png",
    browserMs: Number(res.headers.get("x-browser-ms-used") || 0),
  };
}

export const __test = { hasBrowser, SHOT_MIN_KM, SHOT_DAILY_CAP };
