# 把飞书机器人接起来（分步教程）

目标：在你自己的飞书里，有一个机器人能**主动给你发卡片**，也能**听懂你发的指令**，卡片上的按钮点了有反应。

全程约 15 分钟，需要你在浏览器里点，代码这边只要填 3 个值。

> 先说清一个容易卡住的术语：飞书里**没有单独的「机器人」对象**。你要做的是「创建一个企业自建应用」，然后给它**打开「机器人」能力**——从此它就是一个机器人：有头像、能进聊天、能收消息。下面每一步都写在飞书开发者后台的哪个位置。

---

## 0. 你会得到什么

```
你的手机飞书  ←──卡片/文本──  Worker（你的服务）
     │                              ▲
     └──发指令 / 点按钮─────────────┘   回调地址：POST https://<你的域名>/webhook/feishu
```

同一个 `/webhook/feishu` 承担三件事，配置一次全通：

| 飞书里的名字 | 本项目怎么处理 |
|---|---|
| 事件订阅（收到消息） | `im.message.receive_v1` → 解析指令、首次自动绑定推送目标 |
| 机器人菜单点击 | `application.bot.menu_v6` → 19 个 `event_key` 各对应一张卡 |
| 卡片回传交互 | `card.action.trigger` → 看线路 / 开关推送 / 输油价 |

---

## 1. 建应用 + 打开机器人能力

1. 打开 <https://open.feishu.cn/app>（飞书开放平台 → 开发者后台），用**你要收卡片的那个账号**登录。
2. **创建企业自建应用**：填名称（比如「理想同学」）、描述、图标，创建。
3. 进入应用 → 左侧「**添加应用能力**」→ 找到「**机器人**」→ 添加。
4. 机器人设置里可以改名字和头像；「消息卡片」相关开关保持默认即可。

> 企业自建应用不需要审核就能给自己用；给同事用需要在「版本管理与发布」里发版并由管理员批准。

---

## 2. 拿 App ID / App Secret

左侧「**凭证与基础信息**」：

- `App ID`（形如 `cli_xxxxxxxxxxxxxxxx`）
- `App Secret`（点「查看」）

把它们填到 Worker（线上用 `wrangler secret put`，本地写进 `.dev.vars`）：

```bash
cd app
npx wrangler secret put FEISHU_APP_ID
npx wrangler secret put FEISHU_APP_SECRET
```

> 这两个值是密钥，**不要提交进 Git**。`.dev.vars` 已在 `.gitignore` 里。

---

## 3. 开权限（两个就够）

左侧「**权限管理**」→ 搜索并开通：

| 权限 | 用途 |
|---|---|
| `im:message` | 读取你发给机器人的消息（指令入口） |
| `im:message:send_as_bot` | 以机器人身份发卡片和文本 |

> 只开这两个就够跑通全部功能。想读群信息才需要 `im:chat:readonly` 之类，本项目用不到。
> **改了权限必须发版**（见第 6 步），否则线上仍按旧权限执行，表现为「发消息没反应」。

---

## 4. 配事件订阅（回调地址）

左侧「**事件与回调**」→「事件配置」：

1. **请求地址**填：`https://<你的域名>/webhook/feishu`
   （本地调试可以先用 ngrok / cloudflared 把 `127.0.0.1:8788` 暴露出去）
2. 点「保存」。飞书会立刻向你发一个 `{"type":"url_verification","challenge":"..."}`，
   本项目会**原样把 `challenge` 回给它**，页面显示「验证成功」即通过。
3. **订阅事件**，添加这两个：

   | 事件 | 说明 |
   |---|---|
   | `接收消息 im.message.receive_v1` | 你发「状态」「电量」等指令靠它 |
   | `机器人自定义菜单事件 application.bot.menu_v6` | 悬浮菜单点击靠它 |

4. **Encrypt Key**（可选但建议）：在「事件与回调」页能看到 `Encrypt Key`，点显示并复制，
   然后 `npx wrangler secret put FEISHU_ENCRYPT_KEY`。
   填了之后飞书会把回调体加密，本项目按 `AES-256-CBC`（key = `SHA256(EncryptKey)`，IV = 密文前 16 字节）解开；
   **不填则按明文处理**——两种都能用，但填了更安全。

> 签名校验：本项目会验证 `X-Lark-Signature = SHA256(timestamp + nonce + encryptKey + rawBody)`，
> 所以填了 Encrypt Key 之后，请把同一个值也配到 secret 里，否则签名对不上会被拒。

---

## 5. 卡片回调地址

同一个 `/webhook/feishu` 也接收卡片按钮事件（`card.action.trigger`）。大多数情况下第 4 步配好就不用再动。

如果你在「消息卡片」相关设置里看到单独的回调地址配置，填同一个地址即可。

> ⚠️ 飞书要求回调**3 秒内返回 200**，否则会重试并给用户报错。
> 本项目在响应路径上**不做任何网络请求**：先立刻回 `200 {}`，真正的查库、发卡放到 `waitUntil` 后台跑。
> 你自己改代码时别在回调里 `await` 网络请求（这是本项目踩过的坑，实测会把响应拖过 3 秒，飞书连发 3 次）。

---

## 6. 发布版本（很容易忘）

左侧「**版本管理与发布**」→「创建版本」→ 填版本号（如 `1.0.0`）→ 申请发布。

- 自己用：企业管理员就是你 → 直接通过。
- 权限或事件有改动：**必须重新发版**，改动才生效。

---

## 7. 绑定推送目标（给机器人发第一条消息）

打开飞书，搜索你刚建的机器人 → 进入单聊 → 随便发一句「状态」。

会发生三件事：

1. 机器人回你一张「车辆状态」卡；
2. 你的 `open_id` 与 `chat_id` 被自动记进 D1 的 `feishu:target`（**只绑第一个给你发消息的人**）；
3. 之后 Cron 采集到需要推送的事件，就往这个目标发。

> **只有绑定的本人能下指令**。别人给机器人发消息会被静默忽略（防止他人套取车辆位置）。
> 想换绑：清掉 D1 里的 `feishu:target` 这一行，再让新的人发一条消息。

---

## 8. 悬浮菜单（19 项）

「**应用功能 → 机器人 → 自定义菜单**」里逐项添加。菜单就是手机聊天窗口底部那排按钮，
点一下等于发一条对应指令。

本项目认这些 `event_key`（填错会自动回「菜单」卡，不会报错）：

| 菜单 | `event_key` | 等价指令 |
|---|---|---|
| 车况 | `veh_status` | 状态 |
| 电量续航 | `veh_battery`（或 `veh_range`） | 电量 |
| 位置 | `veh_where` | 位置 |
| 充电情况 | `veh_charge` | 充电 |
| 保养 | `veh_maint` | 保养 |
| 今天 | `rep_today` | 今天 |
| 昨天 | `rep_yesterday` | 昨天 |
| 本周 | `rep_week` | 本周 |
| 上周 | `rep_week_last` | 上周 |
| 本月 | `rep_month` | 本月 |
| 上月 | `rep_month_last` | 上月 |
| 能耗 | `rep_energy` | 能耗 |
| 账单 | `rep_bills` | 账单 |
| 行程 | `trip_latest` | 行程 |
| 油价 | `trip_fuelprice` | 油价 |
| 电价 | `trip_elecprice` | 电价 |
| 菜单 | `help_menu` | 菜单 |
| 推送开关 | `help_push` | 推送 |
| 帮助 | `help_help` | 帮助 |

> 飞书后台每层菜单最多 5 项，所以 19 项要分 4 个一级菜单（本项目是「车辆状态 / 用车报告 / 更多信息」这样分的）。
> 悬浮菜单**只在手机单聊里显示**，桌面端不显示，这是飞书的限制。

---

## 9. 验收清单

- [ ] 事件订阅页点「保存」显示验证成功
- [ ] 给机器人发「菜单」→ 收到指令菜单卡
- [ ] 发「状态」→ 收到车辆状态卡，且 6 个按钮都在
- [ ] 点卡片上的按钮 → 有 toast 反馈，随后收到新卡
- [ ] `npx wrangler tail` 能看到 `[feishu]` 日志、没有 `code=10003`
- [ ] 手机底部能看到你配的悬浮菜单

---

## 10. 常见错误对照

| 现象 | 原因 | 怎么办 |
|---|---|---|
| 回调地址保存时报「验证失败」 | Worker 没起来 / 路径写错 / 没回 `challenge` | 先 `curl -X POST https://<域名>/webhook/feishu -d '{"type":"url_verification","challenge":"abc"}'` 应返回 `{"challenge":"abc"}` |
| 发消息没反应 | 权限没发版 | 重新「创建版本并发布」 |
| 日志 `取 tenant_access_token 失败: code=10003 msg=invalid param` | `FEISHU_APP_ID`/`FEISHU_APP_SECRET` 没填或填错 | 重新 `wrangler secret put`，注意别带空格和引号 |
| 卡片发出去了，但点按钮报错/转圈 | 回调超 3 秒（在回调里 await 了网络） | 保持「先 200，再 waitUntil」的写法 |
| 别人发消息也能收到卡 | 不该发生——只有绑定的 `open_id` 能下发指令 | 检查 D1 的 `feishu:target` 是否被改过 |
| 换了个应用，之前能用现在不行 | `open_id` 是**按应用隔离**的 | 重新发一条消息重新绑定 |
| 卡片里的「查看线路图」点开是空白 | 没配 `TRIP_SHARE_SECRET` 或域名变了 | 见 [setup-cloudflare.md](setup-cloudflare.md) 的 secret 一节 |

---

## 相关文件

| 文件 | 作用 |
|---|---|
| `app/src/index.js:363` | `/webhook/feishu` 入口，分发三类回调 |
| `app/src/lib/feishu.js` | 签名校验、AES 解密、`sendMessage` / `sendCard` |
| `app/src/lib/commands.js` | 20 条文本指令 → 14 张查询卡；`BOT_MENU_KEYS` 白名单 |
| `app/src/lib/cards.js` | 34 种卡片的 JSON 构造 |
