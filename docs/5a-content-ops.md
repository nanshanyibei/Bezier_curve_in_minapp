# 5A 景区内容运营手册

> 面向：维护者自己（一个人操作就够，不需要后台）。
> 关联：[`docs/5a-content-architecture.md`](./5a-content-architecture.md)（架构与门禁规则）、`utils/attrContent.js`（运行时加载）、`pages/travel/spot/`（详情页）。

## 0. 全景：一条命令一层，人工只做两件事

```
AI 草稿  →  机器门禁  →  人工评审  →  导入云库
gen-all.js  validate-details.js  preview-details.js  控制台
```

人工只做两件事：**看评审页挑毛病** + **补门票/开放时间**。其余全自动。

## 1. 前提：配一个模型 key

脚本走 OpenAI 兼容接口，换服务商只改环境变量：

```bash
# 硅基流动（默认，便宜）
export SILICONFLOW_KEY=sk-xxx

# 或 DeepSeek 官方
export CONTENT_BASE=https://api.deepseek.com/v1
export CONTENT_KEY=sk-xxx
export CONTENT_MODEL=deepseek-chat

# 或通义
export CONTENT_BASE=https://dashscope.aliyuncs.com/compatible-mode/v1
export CONTENT_MODEL=qwen-plus
export CONTENT_KEY=sk-xxx
```

成本参考：358 家约 43 万 token，DeepSeek-V4-Flash 量级在 **2 元以内**。

## 2. 生成：先试一个省，别一上来跑全量

```bash
# 看一眼计划（不花钱、不请求）
node scripts/gen-all.js --dry

# 试水：家数最多的江苏，先写 6 家
node scripts/gen-all.js --prov 320000 --per 6

# 满意了再放开
node scripts/gen-all.js --prov 320000            # 把江苏补齐
node scripts/gen-all.js --top 5                  # 家数最多的 5 个省
node scripts/gen-all.js --per 10                 # 全部省，每省最多 10 家
node scripts/gen-all.js                          # 全量补齐 349 家
```

要点：

- **断点续跑**：已写过内容的景区不会再调 AI，中断了直接重跑同一条命令即可。
- **不覆盖人工内容**：`--merge` 只追加缺的，已存在的条目不动。
- **失败不中断**：某个省挂了会记下来继续跑下一个，最后汇总里列出失败的省。
- 单省失败或部分失败，重跑同命令就能补上（AI 偶尔输出不合法 JSON，被 `clean()` 丢掉是正常的）。

产出：`content/details/<省adcode>.json`，每个景区条目带 `src.intro = "generated"` 标记未复核。

## 3. 校验：门禁不过就不出导入文件

```bash
node scripts/validate-details.js            # 全部省
node scripts/validate-details.js 320000     # 单个省
```

看两类输出：

- `✗` ERROR —— **必须修**，否则该省不产出导入文件。常见：名字和名录不一致、字数超限、标签不在词表、命中套话。
- `·` WARN —— 可以不管。绝大多数是「未填 ticket / hours」，这是**故意的**：票价和开放时间 AI 一律不写，页面会自动隐藏该行。

通过后产出 `backup/wxcloud-import/attraction_details/p_<adcode>.json`（JSON Lines，一行一个省文档）。

## 4. 评审：用浏览器过一遍，比看 JSON 快十倍

```bash
node scripts/preview-details.js            # 全部省
node scripts/preview-details.js 320000     # 单个省
open content/preview/p_320000.html
```

按真实详情页样式排版，未填字段标黄。重点看三处：

1. **看点是不是空话**——要能落到「看什么、在哪个位置、什么时候最好」。
2. **有没有张冠李戴**——AI 最容易把相邻景区的特征写串。
3. **数字类描述**——年代、面积、海拔，对不上的直接删，宁可不写。

发现问题就直接改 `content/details/<adcode>.json`，改完重跑第 3 步。

## 5. 导入：合并成单文件，一次搞定

```bash
node scripts/validate-details.js --bundle
```

产出 `backup/wxcloud-import/attraction_details/_all.json`（全部省合并，31 个省约 300KB），然后：

微信开发者工具 → 云开发 → 数据库 → 集合 `attraction_details` → 导入 → 选 `_all.json` → 冲突模式 **upsert** → 确定。

> 控制台一次只能选一个文件，所以别逐省导入。单省调试时才用 `p_<adcode>.json`。

集合权限必须是 **「所有用户可读，仅管理端可写」**，否则客户端读不到。

## 6. 人工补事实字段（可选但强烈建议）

AI 不写 `ticket` / `hours` / `transport` / `tips`，这四项要人工核实后填进 `content/details/<adcode>.json`：

```json
{
  "name": "拙政园",
  "ticket": "旺季 80 元 / 淡季 70 元",
  "hours": "07:30-17:30（17:00 停止入园）",
  "transport": "苏州市区地铁 4 号线北寺塔站步行约 800m",
  "tips": "旺季需提前 1-3 天在公众号预约，周一闭馆维护",
  "src": { "intro": "generated", "ticket": "manual", "hours": "manual" }
}
```

填完重跑第 3、5 步。**`src.ticket` 不写 `manual` 而留着 generated 会被门禁拦截**，这是防 AI 编票价的最后一道闸。

## 7. 更新已发布的内容

改了内容重新导入即可，`_id` 相同走 upsert 覆盖。客户端多久能看到：

| 场景 | 生效时机 |
|---|---|
| 用户正在看该省 | 下拉刷新（详情页）立即生效 |
| 用户 6 小时内打开过该省 | 最长 6 小时后，再次点开该省名录时后台刷新 |
| 用户本地无缓存 | 立即生效 |

本地缓存 TTL 30 天，但 `refresh()` 会在每次打开名录时按 6 小时间隔主动拉取并**无条件覆盖**，所以不需要手动递增 `v`。

`updatedAt` 记得更新（`gen-details.js --merge` 会自动改），详情页底部显示的就是它。

## 8. 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| `缺 API key` | 环境变量没传 | 见第 1 节，注意 `export` 后再跑 |
| 某省「一条都没生成成功」 | 模型名错 / 余额不足 / 响应不是合法 JSON | 先 `--dry` 看提示词，再单独跑 `gen-details.js <prov> --limit 1` 看原始报错 |
| `name 不在名录里` | AI 改了景区名（常见：少了「景区」二字） | 直接把 `name` 改回 `assets/data/attractions-5a.js` 里的原名，或用 `node -e` 查该省名字清单 |
| 导入报「格式错误」 | 文件被编辑器改成了 JSON 数组 | 必须是 JSON Lines：一行一个文档，不要包成 `[ ... ]` |
| 导入成功但小程序看不到 | 集合权限不对 / 没重建索引 | 权限改「所有用户可读，仅管理端可写」；详情页下拉刷新一次 |
| 详情页显示「暂无详细介绍」 | 该省还没导入，或 `prov` 传错 | 名录里点进去的 `prov` 是省级 adcode，云文档 `_id` 必须是 `p_<前两位>0000` |

## 9. 命名与 adcode 对照（31 个省级单位）

| adcode | 省级单位 | 家数 |
|---|---|---|
| 320000 | 江苏 | 26 |
| 330000 | 浙江 | 22 |
| 510000 | 四川 | 18 |
| 650000 | 新疆 | 18 |
| 410000 | 河南 | 17 |
| 370000 | 山东 | 16 |
| 420000 | 湖北 | 16 |
| 440000 | 广东 | 16 |
| 360000 | 江西 | 15 |
| 130000 | 河北 | 13 |
| 340000 | 安徽 | 13 |
| 610000 | 陕西 | 13 |
| 140000 | 山西 | 12 |
| 350000 | 福建 | 12 |
| 430000 | 湖南 | 12 |
| 500000 | 重庆 | 12 |
| 450000 | 广西 | 10 |
| 520000 | 贵州 | 10 |
| 530000 | 云南 | 10 |
| 110000 | 北京 | 9（已完成） |
| 220000 | 吉林 | 9 |
| 150000 | 内蒙古 | 8 |
| 620000 | 甘肃 | 8 |
| 210000 | 辽宁 | 7 |
| 230000 | 黑龙江 | 7 |
| 460000 | 海南 | 7 |
| 640000 | 宁夏 | 6 |
| 310000 | 上海 | 5 |
| 540000 | 西藏 | 5 |
| 630000 | 青海 | 4 |
| 120000 | 天津 | 2 |

合计 358 家。
