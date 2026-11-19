# 5A 景区内容体系：架构与操作手册

> 2026-11-19 落地。解决「名录只有名字，点进去没内容」。
> 核心取舍：**质量靠发布前的门禁，体积靠运行时不带内容**。

## 1. 分层

| 层 | 存放 | 体积 | 谁维护 |
|---|---|---|---|
| 骨架 | `assets/data/attractions-5a.js`（随包，358 家） | 29KB | 脚本生成，勿手改 |
| 内容 | 云数据库 `attraction_details`（一省一文档） | 10~40KB/省 | `content/details/*.json` → 脚本 → 导入 |
| 主图 | 云存储 fileID | 80~120KB/张 | 运营手传 |
| 内容源 | `content/details/<省adcode>.json`（不进包，git 跟踪） | ~1KB/家 | 人工 + 草稿 |
| 导入产物 | `backup/wxcloud-import/attraction_details/p_xxxxxx.json` | 同内容 | 脚本生成 |

`content/` 已加入 `project.config.json` 的 `packOptions.ignore`，`scripts/` 原本就在忽略列表里，两者都不进上传包。

## 2. 云开发准备工作（一次性）

数据库建两个集合：

| 集合 | 权限 | 用途 |
|---|---|---|
| `attraction_details` | **所有用户可读，仅管理端可写** | 景区内容，一省一文档 `_id = p_<省adcode>` |
| `spot_marks` | **仅创建者可读写** | 景区级「去过/想去」，`_id = s_<省adcode>_<名称指纹>` |

云存储建 `attractions/` 目录放主图（建议 webp，长边 750，≤120KB）。

## 3. 内容生产流程

```bash
# 1) 生成草稿（离线，key 只在本地环境变量）
SILICONFLOW_KEY=sk-xxx node scripts/gen-details.js 110000 --limit 5

# 2) 门禁校验，通过则产出导入文件
node scripts/validate-details.js 110000

# 3) 出评审页，用浏览器逐条看
node scripts/preview-details.js 110000
open content/preview/p_110000.html    # 未填字段标黄

# 4) 云开发控制台 → 数据库 → attraction_details → 导入 → 冲突模式 upsert
```

`gen-details.js --merge` 可直接并入 `content/details/<prov>.json`，生成条目的 `src.intro = "generated"`，评审后把 `src` 改回 `manual` 表示已核实。

## 4. 内容门禁规则（`scripts/validate-details.js`）

**ERROR（不产出导入文件）**

- `name` 必须与 `attractions-5a.js` 完全一致（连「景区」后缀都对）
- `oneline` 8~24 字；`intro` 120~240 字；`highlights` 3~5 条、每条 8~30 字；`tags` 3~6 个且在受控词表内
- 套话/绝对化用语：`秀丽|历史悠久|值得一游|必去|第一|最美|驰名|人间仙境|美不胜收|不容错过|打卡圣地`
- `ticket`/`hours` 若存在 `src` 标为 `generated` → 直接报错（这两项必须人工核实）
- 同省 `oneline` 重复

**WARN（可发布）**：`ticket`/`hours`/`tips`/`transport` 等可选字段未填 → 页面自动隐藏该行，不留空白。

## 5. 运行时

```
名录弹层：包内骨架立即渲染（0ms）→ attrContent.load(省) 补 oneline（内存→本地→云端）
详情页：  attrContent.spotOf(省, name) —— 同一个三级缓存
图片：    attrImage.resolve(fileID) —— 云存储下载到 USER_DATA_PATH，LRU 50MB
标记：    spotStore（本地 storage + spot_marks 云端，新者胜）
```

| 文件 | 职责 |
|---|---|
| `utils/attrContent.js` | 省内容三级缓存；本地 TTL 30 天，LRU 8 省；6 小时内不重复请求 |
| `utils/attrImage.js` | fileID → 本地永久路径，50MB LRU |
| `utils/spotStore.js` | 景区级去过/想去，复用 `cb.setDoc/listDocs` |
| `pages/travel/spot/spot` | 详情页：主图/徽标/一句话/标签/看点/简介/实用信息/提醒 |

**降级矩阵**（前端必须逐项成立）：

| 缺失 | 表现 |
|---|---|
| 无该省内容 / 云端不可达 | 名录只有名称年份，详情页显示「暂无详细介绍」+ 下拉刷新 |
| 无 `oneline` | 名录副标题不占高 |
| 无 `img` | 类型渐变底 + 首字 |
| 无 `ticket`/`hours` | 该行不渲染 |
| 缓存 JSON 损坏 | `JSON.parse` 失败即丢弃并重拉 |

## 6. 体积纪律

- `scripts/build.js` 已有体积门禁：主包 > 1840KB 直接构建失败，并分行打印主包/分包/合计
- 当前：主包 280KB，分包 569KB
- 新增内容一律走云端；图片一律走云存储；评审页/内容源放 `content/`（不进包）

## 7. 审核注意（个人主体）

- 内容定位为「个人足迹工具的辅助信息」，**不接购票、不导流、不做公开评论/评分**
- 每页底部固定声明：门票与开放时间仅供参考，以景区官方公告为准
- 图片来源必须有授权（`imgCredit`）；无授权就用渐变占位，不硬凑
