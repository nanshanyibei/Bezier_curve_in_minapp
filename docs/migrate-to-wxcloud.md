# 评估：迁到微信云开发（wx.cloud）数据库

> 结论：**已实施**。代码迁移完成于 2026-11-18，新环境 ai-walk-d6g6stcxs36a8e427（新小程序「AI 足迹星球」，appid wx5bf7979372d41257）。
> 方案演进：2026-11-16 评估 → 11-17 归因复核（PG 核时是业务自带，砍不掉）→ 11-17 发现免费环境资格按 appid 判定（旧号已发布不可用）→ 11-17 注册新小程序走免费环境（未发布阶段免续费，发布后 15 天到期，活动截止 2026-12-31，最坏转 ¥19.9/月）。

## 一、为什么迁

| 现状痛点 | 迁到微信云开发后 |
|---|---|
| 腾讯云 CloudBase 体验版 3000 点/月，PG 核时（342 点/核时）一个月就烧光，剩 415 点 | 微信云开发基础套餐 ¥19.9/月，**40,000 点/月**，按调用次数计费，估月耗 150~500 点（约 1%） |
| 数据库按「实例在线时间 × CPU」计费，闲置也扣 | 文档型数据库按**读写次数**计费（200 点/万次）+ 容量（40 点/GB/天），不查询不扣 |
| 云函数网关域名进不了 request 白名单，必须买域名 + ICP 备案（1~20 工作日） | `wx.cloud` 走微信内部通道，**免域名、免备案**，真机不开调试模式也能用 |
| 自建 HMAC token 鉴权（`wxauth` 289 行云函数） | openid 由云开发自动注入 `_openid`，集合权限设「仅创建者可读写」即可，**wxauth 整套可删** |
| AI 生成的 key 要经网关透传/环境变量两套逻辑 | 云函数环境变量一套，且云函数出网不受域名白名单限制 |

## 二、成本对照

| 项 | 现方案（腾讯云 CloudBase 体验版） | 微信云开发基础套餐（非新用户） |
|---|---|---|
| 月费 | ¥0（但额度必爆，爆了停服） | **¥19.9/月**（原价 ¥39，5 折长期） |
| 额度 | 3,000 点 | 40,000 点/月 |
| 额外必要支出 | 域名 ¥29~69/年 + 备案工时 | 无 |
| 隐性成本 | PG 实例常驻核时、pgdoc 兼容层双查 | 无 |

> 对照：腾讯云 CloudBase 个人版同为 ¥19.9/月、40,000 点，但①PG 自动暂停未在购买指南中得到确认；②域名备案问题依然存在，仍需买域名。两案同价，取解决备案的 A 案。

### 2026-11-17 归因复核（MCP 用量明细）

- PG CU 逐日消耗（核秒 → 资源点）：11-09 起 687/1238/**5252/6760/9522**/3196/410/1371/547，合计 28983 核秒 = 2753.84 点，**占周期总消耗 2755 点的 99.9%**
- 与业务量比对：11-13 烧 904 点当天，网关调用仅 376 次、云函数 281 次 → **平均单次请求摊约 25 核秒**，pgdoc 兼容层放大效应严重
- 文档型数据库（FLEXDB）模块计费恒为 0：集合读写全部由 PG 承载并按 CU 计费，**没有独立的便宜通道可切**
- 即使按最安静的两天（39~52 点/天）估算，月耗也在 1200 点以上，脉冲天（500~900 点）直接逼近 3000 点月额 → **体验版必爆，与开发活动无关**
- PG 实例（SHARED postgres-6iv7m92a）承载 pgdoc，**不可释放**；计费周期 11-09~12-09，截至 11-17 已用 2767.88/3000 点，EnableOverrun=false → **约 11-19 前后当月停服**

估算月耗（按日均 200 次读写 + 20 次 AI 补充）：

- 数据库调用 0.6 万次 → 120 点
- 容量 20MB × 30 天 → 24 点
- 云函数调用 / 出网 → 个位数
- 合计 **约 150~500 点，占 40,000 的 1% 左右**

## 三、要改什么

| 文件 | 现状 | 改动 | 量级 |
|---|---|---|---|
| `utils/cb.js` | 540 行：网关 + token + SDK 双通道 | 换成 `wx.cloud.database()` / `wx.cloud.uploadFile` 直调，删 token/login/gwRequest | 540 → 约 200 行 |
| `cloudfunctions/wxauth/` | 289 行，自签 token 代理读写 | **整目录删除** | -289 行 |
| `cloudfunctions/genAttraction/` | `@cloudbase/node-sdk` + HTTP 网关 | 换 `wx-server-sdk`，`event.openid` 直接可用，key 走环境变量 | 约 20 行差异 |
| `config.js` | `CLOUDBASE_ENV` / `CLOUD_GATEWAY_BASE` | 换成 `WX_CLOUD_ENV`，网关地址整段删除 | 小 |
| `app.js` | 无 wx.cloud 初始化 | 加 `wx.cloud.init({ env, traceUser: true })` | 5 行 |
| `pages/**` | 调用 `cb.xxx()` 共 16 个方法 | **保持方法名与签名不变**，页面零改动 | 0 |

方法名清单（对外契约，迁移时保持不动）：
`ready / cloudReady / getLoginInfo / getUserKey / getOpenid / fetchMarks / pushMark / fetchAttractions / listDocs / setDoc / removeDoc / clearCollection / uploadImage / getFileUrls / deleteFiles / genAttractions`

## 四、数据搬迁

集合：`marks`、`diaries`、`chats`、`attractions`（后两个量大）

1. 用现有 SDK 遍历四个集合 → 导出 JSON（约 20MB，一次性）
2. 云开发侧建同名集合，权限：`marks`/`diaries`/`chats` 设「仅创建者可读写」，`attractions` 设「所有用户可读」
3. 导入时把原 `owner` 字段映射成 `_openid` —— **openid 是同一 appid 下同一个值**，可直接沿用，用户数据自动认回
4. 云存储图片：旧环境 fileID 迁移后失效，需重新上传并在文档里换新 fileID（**待确认图片数量**，越少越省事）

## 五、工作量与风险

- 估算 **1~1.5 天**（数据层重写 4~6h、云函数 2h、数据搬迁 2~3h、真机验证 2h）
- 风险点：
  1. 基础套餐 ¥19.9/月为长期 5 折价，后续折扣如有变化官方提前 3 个月通知；不迁则额度必爆停服，两害取其轻
  2. 需在微信开发者工具里对 appid `wx5bf7979372d41257` 开通云开发并购买基础套餐（¥19.9/月）
  3. pgdoc 的 `documents_N` 不能直连 SQL 导出，必须走 SDK 遍历
  4. 图片搬迁是唯一可能卡住的环节，取决于现有图片量

## 六、备选（不想动代码时的止血方案）

腾讯云 CloudBase 升到**个人版 ¥19.9/月**：套餐文档写明「关系型数据库，个人版默认开启自动暂停」，核时消耗应大幅下降，额度涨到 40,000 点。但**域名备案问题依然存在**，且仍受 pgdoc 兼容层拖累。属于过渡方案，不解决根因。

---

## 五、实施记录（2026-11-18）

新环境：`ai-walk-d6g6stcxs36a8e427`（小程序「AI 足迹星球」）。

### 已完成的代码改动

| 文件 | 改动 |
|---|---|
| `utils/cb.js` | 541 行 → 全量重写：wx.cloud.database() 直查、分页绕过客户端单次 20 条上限、uploadFile 直传（去掉 base64/2MB 网关限制）、callFunction 调 genAttraction；**16 个对外方法签名不变，页面零改动** |
| `config.js` | `CLOUDBASE_ENV`/`CLOUD_GATEWAY_BASE` 删除，新增 `WX_CLOUD_ENV` |
| `cloudfunctions/whoami/` | 新增：返回调用者 openid（登录态确认 + 数据认领用） |
| `cloudfunctions/genAttraction/` | 重写：@cloudbase/node-sdk → wx-server-sdk，删 HMAC token/pgdoc 兼容，新增 config.json timeout 55s |
| `cloudfunctions/wxauth/` | **整目录删除**（-289 行，HMAC 鉴权不再需要） |

### 待办（用户手动）

1. 开发者工具确认 `project.config.json` appid 为新号（当前 wx5bf7979372d41257，如与后台一致则不动）
2. 右键 `whoami` / `genAttraction` → 上传并部署：云端安装依赖
3. genAttraction 配置环境变量 `SILICONFLOW_KEY`（云开发控制台 → 云函数 → 配置）
4. 数据库建集合：marks / diaries / chats / memories（权限=仅创建者可读写），attractions（权限=所有用户可读）
5. 数据导入：backup/cloudbase-export-2026-11-17/ 四个 JSON，owner→_openid 映射（每人打开新小程序收集新 openid 后生成导入文件）
