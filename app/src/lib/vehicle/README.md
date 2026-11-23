# 数据源层（vehicle provider）

业务层（`collector.js` / `cards.js` / 面板 / 分享页）只依赖一张「接口名片」，不认识任何厂商的协议。
想看业务层怎么用，读 `collector.js` 开头那几行 import 就够了。

## 两种模式

由 Worker 环境变量 `VEHICLE_PROVIDER` 决定：

| 值 | 实现 | 说明 |
|---|---|---|
| `sample`（默认） | `sample.js` | 编造的数据，不联网、不需要凭据。`wrangler dev` 直接能跑，21 张卡都有数可看 |
| `custom` | `custom.js` | 空壳，留给你接自己的车 |

## 接口名片

```js
client.vin                              // string
client.provider                         // "sample" | "custom"
client.credentialStatus()               // { level, days_left, expires_at, expiry_source, warnings[] }
client.getVss(paths, opts)              // { [path]: { value, ts } }   批量读实时信号
client.travel(path)                     // 原始 JSON（日汇总、充电记录这类直取接口）
client.getChargeSessions(dt, type)      // 原始 JSON
client.getVehicles()                    // 车辆列表（一次性，运行期不要再调）
client.refresh()                        // 可选：续期，返回 boolean
```

`getVss` 的 `paths` 全部来自 `app/src/lib/vss-paths.js`，字段语义见 `app/src/lib/fields.js`。
接自己的车时，**改映射表比重写业务快一个数量级**。

## 为什么把认证协议摘出去

原项目里这一层包含登录签名、密钥派生等实现，那属于厂商私有素材、也只服务于「登录我自己的车」，
对读者没有价值。所以本仓库只保留接口与示例实现，认证请走你自己的正规渠道
（官方开放平台、或你自己账号下的授权）。
