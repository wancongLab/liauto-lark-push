# 怎么把「你自己的车」接进来

这个仓库分成两半，这一页讲**上半截**：车的数据从哪来、怎么塞进这套系统。

```
① 拿到车的数据  ←── 你在这里（本项目只提供接口 + 示例数据）
        │
        ▼  VSS 信号 / 行程 / 充电记录
② 拿来做事      ←── 本仓库的主体：卡片、面板、分享页、推送、去重、告警
```

---

## 1. 为什么「拿数据」这一层没有随仓库发布

理想（以及绝大多数车企）的 App 接口没有对外开放。真正跑通它需要的那层代码：

- 属于厂商的私有素材，分发出去既不合规也可能被下架；
- 和设备绑定（`device_id` / 密钥 / 令牌），换个人跑必须换一套；
- 真正需要它的人，应该用**自己的账号**、自己承担风险。

所以仓库里只有一层接口 `app/src/lib/vehicle/`：

| 实现 | 用途 |
|---|---|
| `sample.js` | 默认。内置模拟数据，`wrangler dev` 就能跑通 34 张卡 + 面板 + 分享页，**不需要任何账号** |
| `custom.js` | 空壳 + 注释。你要接自己的车，就实现这个 |

---

## 2. 接口长什么样

```js
class VehicleClient {
  vin                              // 车架号（你自己的车的）
  provider                         // "sample" | "custom"

  credentialStatus()               // { level, days_left, expires_at, expiry_source, warnings[] }
                                   //   level: ok | warning | critical | dead | sample
                                   //   面板右上角徽标、凭据告警卡都读它

  async getVss(paths, opts)        // 批量读信号 → { [path]: { value, ts } }
                                   //   paths 是 app/src/lib/vss-paths.js 里那 151 条
                                   //   opts.maxSubrequests：单次调用的请求预算（Workers 免费版 50）

  async travel(path)               // 原始 GET（日汇总 / 行程列表），返回 { code, data }
  async getChargeSessions(dt, type)// 充电记录
  async getVehicles()              // 车辆列表
  async refresh()                  // 可选：续期，成功返回 true
}
```

`getVss` 是核心：**151 条 path 都要能返回**，值的含义见 `app/src/lib/fields.js` 的 `F` 表
（那是唯一可信来源，命名是厂商自定义的，不是 VSS 标准名）。

---

## 3. 三条可走的路

### A. 官方开放平台（推荐，如果拿得到）

拿到 HTTP 接口后：

1. 在 `custom.js` 里实现 `getVss()`：把平台返回的字段映射到 `F` 表的 151 条 path；
2. `travel()` 返回日汇总（`travelMileage` / `elecMileage` / `elecEnergy` 等字段名照 `sample.js` 的 `dailyAggregate()`）；
3. 凭据放 Worker secret：`npx wrangler secret put XXX_TOKEN`。

### B. 自己逆向 / 抓包（合规风险自负）

- 登录态、签名、设备密钥**只能放你自己的环境**（Worker secret 或 D1），不要提交；
- 先在一个 `node` 脚本里跑通「登录 → 读一条 VSS」，再搬进 `custom.js`；
- `credentialStatus()` 必须如实反映剩余天数：这套系统的告警、自动降级都靠它。

### C. 车机/网关直连

有 CAN/OBD 网关或 Home Assistant 插件时，让它把数据 POST 给一个你自己加的
`/api/ingest` 端点，再把值落到 `signal_sample` / `daily_stat`（表结构见 `app/migrations/`）。
这条路可以完全不需要登录协议。

---

## 4. 接进来之后要做的三件事

1. **改围栏坐标**：`app/scripts/seed.sql` 里的 `geofence`（家 / 公司）改成你的真实坐标，
   `enabled=1`。到家 / 离家 / 停车掉电这些卡都靠它。
2. **改电价油价**：`POST /api/price {"electric":0.62,"fuel":7.85}`，或在面板里改。
3. **绑飞书机器人**：见根目录 `README.md` 的「快速开始」。

---

## 5. 验证清单

```bash
cd app
npx wrangler dev                                   # 本地起服务
curl -X POST localhost:8788/api/collect -H "Cookie: li_token=<API_TOKEN>"
#   → errors: []           采集链路通
#   → steps[0].vss: 151    151 条信号都回来了
#   → credentials.level    你自己的凭据状态

curl -X POST localhost:8788/api/test-push \
  -H "Cookie: li_token=<API_TOKEN>" -H "Content-Type: application/json" \
  -d '{"kind":"status","dry_run":true}'
#   → card.header.title = 车辆状态，数字是你自己车的（dry_run 不会真发到飞书）
```

改完 `VEHICLE_PROVIDER=custom` 再跑一遍同样两条，数字应该变成你自己车的。

---

## 附：让 AI 帮你读上游

不点名的通用做法（GitHub 上能搜到几个把理想汽车接进 Home Assistant 的项目，任选其一即可）：

1. 让 AI 打开那个仓库，先读 README 与 `api` / `coordinator` 这类文件；
2. 让它回答四个问题：**登录流程是怎样的 / token 怎么续 / 请求哪几个接口 / 字段怎么映射**；
3. 拿着答案实现 `app/src/lib/vehicle/custom.js` 里的 `getVss()` 与 `travel()`。

本项目没有复制任何上游代码，也没有搬运其字段表 —— 151 条路径是在真车上实测的。用不用上游、怎么用，请自行判断并遵守其许可与服务条款。

**如果你确实靠它做成了，请回去给作者点一个 Star**，顺手在 issue 或 README 里留一句谢谢。这类项目都是作者自己踩完坑、无偿写成文档的，Star 是唯一不用花钱的回报；也让后来的人更容易搜到它，而不是各自从零再踩一遍。用别人的东西不寒碜，用了不说一声才寒碜。
