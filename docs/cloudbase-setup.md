# CloudBase 通用版接入配置指南（FREE 体验版）

代码已全部就绪，以下是在腾讯云控制台 + 微信开发者工具需要手动完成的步骤。

## 一、腾讯云控制台（tcb.cloud.tencent.com）

1. **开通环境**：注册/登录腾讯云 → CloudBase 控制台 → 新建环境（免费体验版，选 `ap-shanghai` 或就近地域）→ 复制「环境 ID（envId）」
2. **填 envId**：改本项目 `config.js` 里 `CLOUDBASE_ENV: 'YOUR_ENV_ID'` 为你的 envId
3. **开启匿名登录**：控制台「身份认证」→ 登录方式 → 开启「匿名登录」

## 二、集合 + 权限（本环境已启用 pgdoc）

**现状（2026-11-11 已办）**：环境 `eligible-gorilla-d4e0n4kdadfbdc4` 是 PG 模式，已通过 `EnablePGDocumentExt` 开通 **pgdoc 插件**（`PostgreSQL[].DocumentExt = true`），文档型数据库 HTTP API 已由 PostgreSQL 承载，数据落在 `pgdoc_data` schema。`marks`、`attractions` 两个集合已创建，集合名和客户端 SDK 调用方式都不变。

⚠️ **pgdoc 只支持四档基础权限，不支持自定义安全规则**，原 `{"read": "auth != null", ...}` 那套在这里不生效。

**权限已配好（2026-11-11）**，不用再动控制台：

| 集合 | AclTag | 控制台叫法 | 实测 |
|---|---|---|---|
| `marks` | `PRIVATE` | 仅创建者可读写 | 跨设备读不到对方标记 ✅ |
| `attractions` | `ADMINWRITE` | 读取全部数据，不可修改数据 | 任意匿名用户可读；写入 403 `admin only` ✅ |

改法（管理端 API，不需要控制台点鼠标）：

```
callCloudApi  service=tcb  action=ModifyDatabaseACL  version=2018-06-08
{ "EnvId": "<envId>", "CollectionName": "attractions", "AclTag": "ADMINWRITE" }
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

其他已验证事实：匿名登录下 `_openid` 会被自动注入（实测文档里带 `_openid`），所以按 `_openid` 判归属的基础权限可用；`utils/cb.js` 里的 `userKey`（设备维度）仍可作为业务层隔离，但服务端归属判定认的是 `_openid`。

## 三、导入种子数据

```
node scripts/export-attractions.js
```

生成 `scripts/attractions-import.jsonl`（34 条省级代表景点）→
控制台「数据库 → 文档型数据库（Document 编辑器）→ attractions → 导入」选择该文件，冲突处理选"插入"。pgdoc 模式下导入的集合固定落在 `pgdoc_data` schema，编辑器里不需要指定 schema；单批上限 1000 条。

## 四、部署云函数 genAttraction

1. 配置环境变量：「云函数 → genAttraction（部署后）→ 配置」：
   - `SILICONFLOW_KEY`：你的硅基流动 API Key（必填）
   - `SILICONFLOW_MODEL`：可选，默认 `deepseek-ai/DeepSeek-V3-0324`
2. 部署方式：控制台「云函数 → 新建」→ 选"本地上传"（zip 打包 `cloudfunctions/genAttraction/`），或用 CloudBase CLI：
   ```
   npm i -g @cloudbase/cli
   tcb fn deploy genAttraction --dir cloudfunctions/genAttraction --env <envId>
   ```
   部署前先在目录里 `npm install`（node-sdk 依赖）。

## 五、微信开发者工具

1. **构建 npm**：工具栏「工具 → 构建 npm」（依赖根目录 `package.json` 的 `@cloudbase/js-sdk`）
   - 未构建前 `utils/cb.js` 会自动降级为纯本地模式，不会崩
2. **request 合法域名**（mp.weixin.qq.com 后台 → 开发管理 → 服务器域名）：
   - 把 CloudBase 分配的 API 域名加入 request 合法域名
   - 具体域名在 CloudBase 控制台「环境 → 概览/安全」查看，形如 `https://tcb-api.tencentcloudapi.com`
   - 开发阶段先在开发者工具「详情 → 本地设置 → 不校验合法域名」跑通
3. 云函数本地开发需在 `project.config.json` 加 `"cloudfunctionRoot": "cloudfunctions/"`（可选，仅用 CLI/控制台部署可不加）

## 六、验证清单

- [ ] 点省份弹层出现「当地推荐」区，有种子数据（如甘肃→莫高窟）
- [ ] 点「AI 补充」返回 5 条景点，再点弹层命中缓存（同一 adcode 不再调 LLM）
- [ ] 标记「去过」→ 云端 `marks` 集合出现 `u_xxx_adcode` 文档
- [ ] 清开发者工具缓存（模拟另一台设备）→ 重新打开，标记被云端合并回来

## 费用预估

FREE 版 3,000 资源点/月（1000 点 ≈ ¥1）：
- DB 读写按 0.5 元/万次折算 → 每月约 6 万次调用额度
- 个人+朋友使用（景点查询走 7 天本地缓存、LLM 结果落库复用）远用不完
- 注意：LLM 生成的云函数**外网出流量**和**资源使用量**也走资源点，正常频率无压力
