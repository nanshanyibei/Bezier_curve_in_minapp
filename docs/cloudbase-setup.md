# CloudBase 通用版接入配置指南（FREE 体验版）

代码已全部就绪，以下是在腾讯云控制台 + 微信开发者工具需要手动完成的步骤。

## 一、腾讯云控制台（tcb.cloud.tencent.com）

1. **开通环境**：注册/登录腾讯云 → CloudBase 控制台 → 新建环境（免费体验版，选 `ap-shanghai` 或就近地域）→ 复制「环境 ID（envId）」
2. **填 envId**：改本项目 `config.js` 里 `CLOUDBASE_ENV: 'YOUR_ENV_ID'` 为你的 envId
3. **开启匿名登录**：控制台「身份认证」→ 登录方式 → 开启「匿名登录」

## 二、集合 + 权限（本环境已启用 pgdoc）

**现状（2026-11-11 已办）**：环境 `eligible-gorilla-d4e0n4kdadfbdc4` 是 PG 模式，已通过 `EnablePGDocumentExt` 开通 **pgdoc 插件**（`PostgreSQL[].DocumentExt = true`），文档型数据库 HTTP API 已由 PostgreSQL 承载，数据落在 `pgdoc_data` schema。`marks`、`attractions` 两个集合已创建，集合名和客户端 SDK 调用方式都不变。

✅ **历史遗留已清理（2026-11-12）**：pgdoc 定型前曾按「直建 PG 裸表」路线在 `public` schema 建过 `public.marks`、`public.attractions`（含 34 条种子 + RLS 策略），与 pgdoc 存储完全不相通。已 `DROP TABLE ... CASCADE` 删除，`public` schema 现在只剩 PostGIS 系统表。pgdoc 正式数据在 `pgdoc_data.documents_N`（N 对应 `pgdoc_catalog.collections` 里的 collection_id：marks=6、attractions=7、diaries=8、chats=9），不受影响；这些 documents 表只允许 pgdoc API 访问，直接 SQL count 会报 `permission denied`，属正常设计，勿当故障排查。

⚠️ **pgdoc 只支持四档基础权限，不支持自定义安全规则**，原 `{"read": "auth != null", ...}` 那套在这里不生效。

**权限已配好（2026-11-11）**，不用再动控制台：

| 集合 | AclTag | 语义 | 谁能访问 |
|---|---|---|---|
| `marks` | `ADMINONLY` | 仅管理端可读写 | 只能经云函数 `wxauth` 网关 |
| `diaries` | `ADMINONLY` | 仅管理端可读写 | 同上 |
| `chats` | `ADMINONLY` | 仅管理端可读写 | 同上 |
| `attractions` | `ADMINWRITE` | 所有用户可读，仅管理端可写 | 客户端直连只读（种子/LLM 数据） |

⚠️ 三个私有集合故意设成 `ADMINONLY`：身份走的是云函数自签 token，不是 CloudBase 登录态，客户端拿不到 `_openid`，所以直接把直连权限关死，全部读写由 `wxauth` 代理并在服务端校验 `owner`。

改法（管理端 API，不需要控制台点鼠标）：

```
callCloudApi  service=tcb  action=ModifyDatabaseACL  version=2018-06-08
{ "EnvId": "<envId>", "CollectionName": "marks", "AclTag": "ADMINONLY" }
```

查当前档位用 `DescribeDatabaseACL`（同参数，返回 `{AclTag, Rule}`）。

AclTag 四档对照（**注意 `READONLY` 不是「只读」，是仅创建者可写**，设错了写接口照样 201）：

| AclTag | 语义 |
|---|---|
| `PRIVATE` | 仅创建者可读写 |
| `READONLY` | 所有用户可读，**仅创建者可写** |
| `ADMINWRITE` | 所有用户可读，仅管理端可写（客户端只读档） |
| `ADMINONLY` | 仅管理端可读写 |

`managePermissions(updateResourcePermission)` 在 PG 环境被平台直接拒（`ModifyResourcePermission does not support PostgreSQL type environments`），PG 里也没有 ACL 表 —— 只能用 `ModifyDatabaseACL`（或控制台）。

⚠️ 已知 quirk：`GET /documents?count=true` 返回的 `total` 在批量 `documents/remove` 之后不会立刻归零（实测删完仍报 `total:2`，但按 `_id` 查已 404、list 为空）。**别依赖 `count=true` 判断条数**，用 `list.length` 或控制台看。

## 二·补、身份方案（为什么数据要走云函数）

目标是「删掉小程序 / 换手机后数据还在」。这要求身份稳定，而 CloudBase 这边三条路走不通：

| 方案 | 结果 |
|---|---|
| `auth.signInWithOpenId()`（SDK 内置） | ❌ 平台 `POST /auth/v1/provider/token` 恒返回 `404 page not found`，环境没真正开通「微信小程序登录」能力，预置的 `WX_CLOUDBASE_MICRO_APP` provider 是空壳 |
| `auth.createTicket()` 自定义票据 | ❌ 云函数里报 `Cannot destructure property 'env_id' of 'credentials'`，**必须有私钥文件**；`createCustomLoginKeys` 返回的私钥被管理端脱敏（PEM 头尾替换成随机串），拿不到可用文件 |
| `wx.cloud` + 环境导入微信侧 | ⚠️ 未采用：需扫码导入，且 `wx.cloud.database()` 走微信专有接口，与 pgdoc 兼容性未验证 |

**最终方案**：云函数 `wxauth` 自己做身份 + 数据网关，客户端用 **HTTP 网关路由**调用（不是 SDK `callFunction`）

```
客户端 wx.login() → code
  → POST https://<env>-1311813133.ap-shanghai.app.tcloudbase.com/wxauth { action:'login', code }
      → 服务端 jscode2session（AppSecret 只在云函数环境变量里）
      → 返回 { openid, token }   token = HMAC(openid + 过期时间)，30 天
  → 后续所有读写 POST /wxauth { action:'pull|put|del|clear', token, col, ... }
```

⚠️ **为什么不用 `callFunction`**：SDK 的 `callFunction` 打 `/v1/functions/{name}:invoke`，匿名身份一律被拒——
`403 {"code":"EXCEED_AUTHORITY","message":"Request exceeds granted authority"}`。
客户端的 catch 拿到的是 `{code:'EXCEED_AUTHORITY', message}`（注意字段是 `message` 不是 `msg`），
所以早期只表现为 `[cb] 就绪: {logged:false, mode:"local", raw:"网关登录失败: empty"}`，看不出真因。

改成 HTTP 网关公网路由后（`auth=false`），云函数拿到的 event 是被包了一层的 `{ path, httpMethod, headers, body }`，
业务参数在 `body` 里（字符串）。云函数已加 `normalizeEvent()` 兼容两种形态，SDK 调用与 HTTP 调用都能用。

安全边界：`openid` 只在服务端出现；客户端只持有签名 token；每条文档的 `owner` 由服务端强制写入，客户端改不了归属；集合权限档 `ADMINONLY` 保证即使客户端直连也读写不了。网关路由本身不带 CloudBase 鉴权，鉴权完全由 token 负责——token 签名密钥是 `sha256('tcb|appid|appsecret')`，AppSecret 不落客户端。

⚠️ **pgdoc 物理结构是 `{ _id, data: {...} }` 两层**（HTTP 网关读取时会展平，node-sdk 直读拿到原始结构）。云函数里 `pull` 必须 `unwrap`，`put` 用 `.doc(id).set({ data: doc })`。另外 `where({ owner })` 匹配不到 `data.owner`，要用 `where({ 'data.owner': openid })`，并保留全量兜底过滤。

其他已验证事实：匿名登录下 `_openid` 会被自动注入，但本方案不依赖它；`utils/cb.js` 里的 `getUserKey()` 登录后返回 openid 指纹，仅供业务层做本地隔离与展示。

## 三、导入种子数据

**已完成（2026-11-11）**：34 条省级代表景点已写入 `attractions`，34 个 adcode 全覆盖，匿名可读、按 adcode 查询已验证。

如需重跑：

```
node scripts/export-attractions.js   # 生成 scripts/attractions-import.jsonl
```

两条导入路径：

1. **API 批量写（推荐，不用点控制台）**——用 service_role 的 api_key 打文档接口，每批 10 条：
   ```
   POST /v1/database/instances/(default)/databases/(default)/collections/attractions/documents
   Authorization: Bearer <api_key>
   { "data": [ {...}, ... ] }
   ```
   `manageAppAuth(createApiKey, keyType='api_key')` 生成临时 key，用完 `deleteApiKey` 删掉。
2. 控制台「数据库 → 文档型数据库（Document 编辑器）→ attractions → 导入」，冲突处理选"插入"。

pgdoc 模式下集合固定落在 `pgdoc_data` schema，编辑器里不需要指定 schema；单批上限 1000 条。

⚠️ 注意：`attractions` 的 AclTag 是 `ADMINWRITE`，**匿名/普通用户写会 403**，只能管理端或 service_role 写。

## 四、部署云函数

### 4.1 `wxauth`（身份 + 数据网关，**必需**）

已部署（2026-11-11），函数名 `wxauth`，运行时 Nodejs18.15，入口 `index.main`。

环境变量：

| Key | 值 |
|---|---|
| `WX_APPID` | `wx19971a62016469bf` |
| `WX_SECRET` | 小程序 AppSecret（只在服务端，不进代码仓库） |

接口：

| action | 入参 | 返回 |
|---|---|---|
| `login` | `code` | `{ code:0, openid, token }` |
| `pull` | `token, col` | `{ code:0, list }` |
| `put` | `token, col, id, data` | `{ code:0 }` |
| `del` | `token, col, id` | `{ code:0 }` |
| `clear` | `token, col` | `{ code:0, n }` |

`col` 只允许 `marks` / `diaries` / `chats`。token 无效返回 401。

**网关路由（必需）**：`/wxauth` 已挂在 HTTP 网关默认域名上，客户端据此访问

```
https://eligible-gorilla-d4e0n4kdadfbdc4-1311813133.ap-shanghai.app.tcloudbase.com/wxauth
```

路由配置（管理端 API）：`manageGateway(createRoute, domain=上面那个域名, path='/wxauth', upstreamResourceType='SCF', targetName='wxauth', auth=false)`。
`queryGateway(listRoutes)` 可核对，`getPrivilege` 看 `enableService/enableAuth`。
建路由只开入口，不放宽上游权限；反过来，路由 `auth=false` 也不代表函数允许匿名 `callFunction`——两者是两条通道。

重新部署：

```
tcb fn deploy wxauth --dir cloudfunctions/wxauth --env <envId>
```

### 4.2 `genAttraction`（AI 补充景点）

已部署（2026-11-11），函数名 `genAttraction`，Nodejs18.15，入口 `index.main`，超时 60s。同域路由 `/genAttraction`（`SCF` 上游、`auth=false`）：

```
https://eligible-gorilla-d4e0n4kdadfbdc4-1311813133.ap-shanghai.app.tcloudbase.com/genAttraction
```

环境变量：

| Key | 值 | 说明 |
|---|---|---|
| `WX_APPID` | `wx19971a62016469bf` | 与 wxauth 同值 |
| `WX_SECRET` | 小程序 AppSecret | 配置后**强制校验 token**，防止公网裸调烧 LLM 额度 |
| `SILICONFLOW_KEY` | 硅基流动 Key | 可空；空时客户端透传自己本地配置的 key（开发期过渡） |
| `SILICONFLOW_MODEL` | 可选 | 默认 `deepseek-ai/DeepSeek-V4-Flash`（2026-11-12 选型 ¥1.5/¥4.5；旧 `DeepSeek-V3-0324` 已下线） |

行为：

1. 配了 `WX_APPID`+`WX_SECRET` 就用与 wxauth 相同的 HMAC 算法校验 `token`，失败返回 `{code:401}`
2. 该 adcode 已有 ≥12 条 `source:'llm'` 数据时直接返回，不再调模型（省额度、防重复触发）
3. 生成结果按 `llm_{adcode}_{name hash}` 作 `_id` 落库，重跑不重复写
4. 返回该 adcode 全量视图（最多 6 条），客户端据此覆盖 7 天缓存

实测分支：无 token → `401`；假 key → `LLM HTTP 401: {"code":30014,"message":"Token is invalid."}`（链路通）。

客户端兜底（`utils/cb.js` 的 `genAttractions`）：

```
云函数返回 code 0 → 用结果
返回 401 / code 2(NO_LLM_KEY) / 网关失败 → 本地 localGen()，用「AI 助手」页配置的 key 直连
```

即**服务端配了 key 就是纯服务端代理**（key 不落客户端），没配也能用，只是 key 临时经请求体透传——正式发布前应配好 `SILICONFLOW_KEY` 并删掉客户端的本地直连分支。

部署（改了代码后）：

```
manageFunctions(updateFunctionCode, functionName='genAttraction',
                functionRootPath='<项目>/cloudfunctions')
```

## 五、微信开发者工具

1. **构建 npm**：工具栏「工具 → 构建 npm」（依赖根目录 `package.json` 的 `@cloudbase/js-sdk`）
   - 未构建前 `utils/cb.js` 会自动降级为纯本地模式，不会崩
2. **request 合法域名**（mp.weixin.qq.com 后台 → 开发管理 → 服务器域名）——**上线前必配**，开发期用「不校验合法域名」跳过：
   - `https://eligible-gorilla-d4e0n4kdadfbdc4-1311813133.ap-shanghai.app.tcloudbase.com`（云函数网关，`/wxauth`）
   - `https://eligible-gorilla-d4e0n4kdadfbdc4.api.tcloudbasegateway.com`（`attractions` 直连读）
   - `https://file.geojson.cn`（行政边界 GeoJSON）
   - 硅基流动 `https://api.siliconflow.cn`（若仍直连 LLM）
   - `project.config.json` 的 `setting.urlCheck` 已设为 `false`，等价于开发者工具里勾选「不校验合法域名」
3. 云函数本地开发需在 `project.config.json` 加 `"cloudfunctionRoot": "cloudfunctions/"`（可选，仅用 CLI/控制台部署可不加）

## 六、验证清单

- [x] `attractions` 34 条种子数据可匿名读、按 adcode 查询命中（已验证）
- [x] `[cb] 就绪: {logged:true, mode:"cloud_gateway", uid:"o..."}`（真机已验证）
- [x] 标记「去过」→ 云端 `marks` 出现 `{openid}_{adcode}` 文档（已验证，青海省）
- [x] 清缓存重编译 → 打开即恢复（本地 harness 验证回灌逻辑）
- [ ] 点省份弹层出现「当地推荐」区，有云端种子数据（如甘肃→敦煌莫高窟）
- [ ] 点「AI 补充」返回 5 条景点，再点命中缓存（同一 adcode 不再调 LLM）
- [ ] 配好 `SILICONFLOW_KEY` 后，客户端即使清空本地 key 也能生成（验证纯服务端代理）

## 费用预估

FREE 版 3,000 资源点/月（1000 点 ≈ ¥1）：
- DB 读写按 0.5 元/万次折算 → 每月约 6 万次调用额度
- 个人+朋友使用（景点查询走 7 天本地缓存、LLM 结果落库复用）远用不完
- 注意：LLM 生成的云函数**外网出流量**和**资源使用量**也走资源点，正常频率无压力
