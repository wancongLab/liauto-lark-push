# 部署到 Cloudflare（分步教程）

目标：把这个项目跑在你自己的 Cloudflare 账号上，**Free 套餐**即可，不买服务器。

需要的东西：Cloudflare 账号（免费）、Node.js 18+、一个你自己能解析的域名（可选，但强烈建议——高德地图的 JS key 要域名白名单）。

全程约 20 分钟。

---

## 0. 先用本地模式跑一遍（推荐）

线上出问题最难查，先在本地确认它能跑：

```bash
git clone <this-repo> && cd liauto-lark-push/app
npm install
cp .dev.vars.example .dev.vars      # 改掉 API_TOKEN
npx wrangler d1 create liauto-lark-push     # 记下打印出来的 database_id
```

把 `database_id` 填进 `app/wrangler.jsonc` 的 `d1_databases[0].database_id`，然后建表 + 灌示例数据：

```bash
npx wrangler d1 execute liauto-lark-push --local --file=migrations/0001_init.sql
npx wrangler d1 execute liauto-lark-push --local --file=migrations/0002_feishu_webhook_log.sql
npx wrangler d1 execute liauto-lark-push --local --file=migrations/0003_trip_log.sql
npx wrangler d1 execute liauto-lark-push --local --file=migrations/0004_fuel_log.sql
npx wrangler d1 execute liauto-lark-push --local --file=scripts/seed.sql
npx wrangler d1 execute liauto-lark-push --local --file=scripts/seed-sample.sql

npx wrangler dev        # 打开 http://127.0.0.1:8788/login?k=<你的 API_TOKEN>
```

面板能打开、能看到电量/续航/里程，就说明代码是通的。此时 `VEHICLE_PROVIDER=sample`，用的是内置模拟数据。

---

## 1. 建 D1（线上库）

```bash
cd app
npx wrangler d1 create liauto-lark-push
```

输出里会有一行 `database_id = "xxxxxxxx-..."`，填进 `wrangler.jsonc`：

```jsonc
"d1_databases": [
  { "binding": "DB", "database_name": "liauto-lark-push", "database_id": "粘贴到这里" }
]
```

> `binding` 必须叫 `DB`——代码里是 `env.DB`，改名会全线 500。

---

## 2. 建 R2（存线路图、停车照片、3D 车模）

```bash
npx wrangler r2 bucket create liauto-lark-push-media
```

`wrangler.jsonc` 里对应：

```jsonc
"r2_buckets": [
  { "binding": "MEDIA", "bucket_name": "liauto-lark-push-media" }
]
```

R2 免费额度 10 GB；本项目存的都是几十 KB 的小图（线路图、海报），一年也就几十 MB。

### 2.1 把 3D 车模传进 R2

面板上的车模不是静态文件，是从 R2 取的（`GET /models/car.glb` → `env.MEDIA.get("models/car.glb")`），所以要单独传一次：

```bash
npx wrangler r2 object put liauto-lark-push-media/models/car.glb --file=assets/public/car.glb
```

传完打开面板点「看车模」，能拖动旋转就对了。没传的话按钮点下去会提示 `model not found`（其他功能不受影响）。

> 车模署名见 [../assets/public/car-license.txt](../assets/public/car-license.txt)（CC BY 4.0，务必保留）。
> 海报 `/car-poster.webp` 是普通静态资源，已经在 `app/public/` 里，不用传 R2。

> 不建 R2 也能跑，但「行程线路图」「停车照片」「3D 车模」会缺失，相关卡片显示占位。

---

## 3. 填 5 个 secret

```bash
npx wrangler secret put API_TOKEN            # 面板登录口令，自己定一串长随机串
npx wrangler secret put FEISHU_APP_ID        # 见 setup-feishu-bot.md
npx wrangler secret put FEISHU_APP_SECRET
npx wrangler secret put FEISHU_ENCRYPT_KEY   # 可留空（不填就别设这个 secret）
npx wrangler secret put AMAP_KEY             # 高德「Web 服务」key
npx wrangler secret put TRIP_SHARE_SECRET    # 行程分享链接的 HMAC 密钥，随便一串长随机
npx wrangler secret put TRIP_LINK_TTL_DAYS   # 可选，默认 365 天
```

| secret | 必填 | 说明 |
|---|---|---|
| `API_TOKEN` | ✅ | 面板 `/login?k=<它>` 的凭证。**等于整车数据权限**，别外传 |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 想要推送就必填 | 不填则卡片只生成不发送 |
| `FEISHU_ENCRYPT_KEY` | 可选 | 和开放平台「Encrypt Key」保持一致 |
| `AMAP_KEY` | 想要地图就填 | 高德**服务端** key（逆地理、静态图） |
| `TRIP_SHARE_SECRET` | 建议填 | 分享链接签名；不填则从 `API_TOKEN` 派生 |
| `TRIP_LINK_TTL_DAYS` | 可选 | 分享链接有效期，默认 365 |

`wrangler.jsonc` 的 `vars` 里还有两个非密钥配置：

```jsonc
"vars": {
  "TZ": "Asia/Shanghai",
  "VEHICLE_PROVIDER": "sample"    // 接自己的车之后改成 custom
}
```

---

## 4. 建表 + 灌数据（线上库要带 `--remote`）

```bash
npx wrangler d1 execute liauto-lark-push --remote --file=migrations/0001_init.sql
npx wrangler d1 execute liauto-lark-push --remote --file=migrations/0002_feishu_webhook_log.sql
npx wrangler d1 execute liauto-lark-push --remote --file=migrations/0003_trip_log.sql
npx wrangler d1 execute liauto-lark-push --remote --file=migrations/0004_fuel_log.sql
npx wrangler d1 execute liauto-lark-push --remote --file=scripts/seed.sql
# 示例数据只用于试跑，接了真车之后可以不清（会被真实数据覆盖）
npx wrangler d1 execute liauto-lark-push --remote --file=scripts/seed-sample.sql
```

> 忘了 `--remote` 只会写本地模拟库，线上还是空表，表现为面板 404 / 卡片全 `--`。

---

## 5. 部署

```bash
npx wrangler deploy
```

成功后会打印一个 `https://liauto-lark-push.<你的子域>.workers.dev` 地址。

**立刻验一次**（这一步别省，语法对不代表能跑）：

```bash
curl -s "https://<你的域名>/api/status" -H "Cookie: li_token=<API_TOKEN>" | head -c 400
```

期望：返回一段 JSON，含 `vehicle` 与各字段（示例数据下电量 62、总里程 30933 km 之类）。
如果返回 `{"error":"unauthorized"}`，说明 cookie 名或 token 不对。

再手动打一次采集（**这次会真的走一遍取数→写库→判断推送**）：

```bash
curl -s -X POST "https://<你的域名>/api/collect" -H "Cookie: li_token=<API_TOKEN>"
```

期望 `{"ok":true, ..., "errors":[], "anomalies":[]}`。`errors` 不为空就是真问题，逐条看。

---

## 5.5 填上你自己的站点地址（PUBLIC_BASE_URL）

卡片里那个「查看本次线路图」按钮、以及线路图截图，都需要一个**绝对地址**。Worker 运行期拿不到自己的域名，所以这个值要你手动填在 `app/wrangler.jsonc` 的 `vars` 里：

```jsonc
"vars": {
  "VEHICLE_PROVIDER": "sample",
  "PUBLIC_BASE_URL": "https://liauto-lark-push.your-name.workers.dev"   // ← 改成你的
}
```

它**不是 secret**（能公开访问的地址，藏起来没意义），所以写在 `vars` 里而不是 `wrangler secret put`。

留空会怎样：不会报错，只是**分享按钮不出现、线路图截图跳过**，其余 33 张卡照常。

> 本地开发时填 `http://127.0.0.1:8788`（`.dev.vars.example` 里已经是这个值）。

---

## 6. 要不要买域名？（不买也能跑）

先给结论：**不买域名也能把这个项目跑起来**，`https://<worker名>.<你的子域>.workers.dev` 这个免费地址就够了。

| 能力 | 只有 workers.dev 时 |
|---|---|
| 飞书收消息 / 发卡片 / 按钮回调 | ✅ 正常（飞书只要求回调地址是公网 HTTPS） |
| 网页面板 + 登录 | ✅ 正常（登录态是 cookie，跟域名绑定在当前 host 上） |
| 行程分享页 `/t/<token>` | ✅ 正常，只是链接长一点、看起来不专业 |
| 行程卡里的线路图 | ✅ 正常（分享页自带一份不依赖高德的兜底画法） |
| 面板里的高德地图 | ⚠️ **取决于高德能不能接受你的 workers.dev 子域**，见下 |

### 面板地图这一项怎么处理

浏览器端的高德 JS key 要在控制台里配「域名白名单」。我没有在 workers.dev 上实测过能不能通过，所以**先用探针法确认**：

1. 去高德控制台 → 应用管理 → 我的应用 → **Web端(JS API)** key → 设置域名白名单，把 `你的worker名.你的子域.workers.dev` 加进去；
2. 打开面板，展开「行程与线路」，点任意一条的「看线路」；
3. 出地图 → 收工，域名可以先不买；只转圈最后出灰字提示「地图加载失败，再点一次会重试」→ 说明这个子域没被接受。

被拒绝时的两条退路（都不用买域名）：

- **就用静态图**：项目里 `app/src/lib/staticmap.js` 已经在用服务端「Web 服务」类型的 key 出静态图，那条链路不校验域名，只要 `AMAP_KEY` 配对就能出图；
- **不显示地图**：把面板「看线路」当成跳转分享页的入口（分享页自带兜底画法，不依赖高德也能画出轨迹）。

> 域名确实能让链接好看、也能免掉上面这个不确定性。想买的话一个 `.com` 一年几十块，托管到 Cloudflare 后按下面步骤绑上即可 —— 但这是**可选项**，不是跑通的前提。

### 绑自定义域名（可选）

1. Cloudflare 控制台 → Workers & Pages → 你的 Worker → **Settings → Domains & Routes → Add custom domain**；
2. 填一个你域名下的子域，比如 `car.example.com`（域名要已托管在 Cloudflare）；
3. 等证书签发（通常 1–2 分钟）。

然后去高德控制台把 `car.example.com` 加进 JS key 的域名白名单。

> 两把 key 别混用：`AMAP_KEY`（服务端）是「Web 服务」类型，浏览器侧 JS key 是「Web 端(JS API)」类型，
> 用错了会报 `INVALID_USER_KEY` 或 `USERKEY_PLAT_NOMATCH`。

---

## 7. Cron

`wrangler.jsonc` 里已经有：

```jsonc
"triggers": { "crons": ["* * * * *"] }
```

Worker 的 cron 最小粒度是 1 分钟，本项目**每分钟被唤醒一次**，但内部会自适应跳过：
车静止且 180 秒内刚采过就直接返回（`{"skipped":true}` 是正常的），行驶中才加密到 60 秒。
这样既不会打爆 CPU，又不会在行驶时漏掉数据。

> Free 套餐 CPU 上限 10ms/请求。本项目把「重活」（出图）放在 Browser Rendering，
> 采集本身只有几十次 fetch + D1 写入。**别在 Worker 里做图片编码**，一定 1102。

---

## 8. （可选）Browser Rendering 出图

行程线路图、停车照片合成图需要浏览器渲染。想在线上出图：

1. 控制台 → Workers → 你的 Worker → Settings → **Runtime → Browser Rendering** 打开，绑定名填 `BROWSER`；
   或在 `wrangler.jsonc` 里加：

   ```jsonc
   "browser": { "binding": "BROWSER" }
   ```

2. Free 套餐每天 10 分钟渲染额度，够出几十张图。

> 没绑也能跑，只是相关图片走 `staticmap`（高德静态图）或直接跳过。

---

## 9. 验收清单

- [ ] `/api/status` 返回 JSON（不是 401）
- [ ] `/login?k=<token>` 打开后跳转、页面有数据
- [ ] `POST /api/collect` 返回 `errors: []`
- [ ] 面板手机视图：首屏有实时状态、明细折叠、无横向滚动
- [ ] 行程分享页 `/t/<token>` 能打开、能双指缩放
- [ ] 飞书收得到卡（见 [setup-feishu-bot.md](setup-feishu-bot.md)）
- [ ] `npx wrangler tail` 里没有 `1102`（CPU 超限）、没有 `429`

---

## 10. 常见问题

| 现象 | 原因 | 怎么办 |
|---|---|---|
| 面板 500，日志 `no such table` | 迁移没在线上跑 | 加 `--remote` 重跑第 4 步 |
| 面板 404 / 卡片全 `--` | dashboard 没数据 | `POST /api/collect` 打一次 |
| 日志 `1102` | 单请求 CPU 超 10ms | 别在 Worker 里做图片处理/大循环；出图走 Browser Rendering |
| `/t/<token>` 打开是 401 | 分享链接签名对不上（换过 `TRIP_SHARE_SECRET`） | 卡片重发一次即可；旧链接失效是设计如此 |
| 浏览器控制台 `INVALID_USER_KEY` | JS key 白名单没配当前域名 | 第 6 步加白名单 |
| `USERKEY_PLAT_NOMATCH` | 服务端 key 和 JS key 类型搞反了 | `AMAP_KEY` 用「Web 服务」，前端用「Web 端(JS API)」 |
| 部署后前端还是旧代码 | 浏览器缓存 | 硬刷新；HTML/JS 是 `max-age=0, must-revalidate`，图片是 7 天 |
| `skipped:true` 一直返回 | 车静止 + 180 秒自适应窗口 | 正常行为，不是错误 |

---

## 相关文件

| 文件 | 作用 |
|---|---|
| `app/wrangler.jsonc` | D1 / R2 / vars / cron 绑定，**要改的都在这里** |
| `app/.dev.vars.example` | 本地变量模板 |
| `app/migrations/*.sql` | 建表脚本 |
| `app/scripts/seed-sample.sql` | 45 天日汇总 + 14 条行程 + 8 次充电的示例数据 |
| `app/src/index.js` | HTTP 入口 + `scheduled()` 定时入口 |
