# Bezier_curve_in_minapp

使用贝塞尔曲线精确还原设计稿，使用纯css模拟微信小程序原生swiper组件部分功能。

同时作为个人工作台小程序：日记、旅行足迹。

## 双环境

小程序个人主体无法申请「深度合成 - AI 问答」类目，因此拆成两套产物：

| 环境 | 位置 | 能力 | 用途 |
|---|---|---|---|
| dev | 仓库根目录 | 全功能，含 AI 问答 / 日记分析 | 日常开发、真机调试、自用 |
| prod | `dist/prod`（构建生成） | 纯本地工具，无任何 AI 代码 | 提审上线 |

### 日常开发

微信开发者工具直接打开仓库根目录，无需构建。

### 生成生产包

```bash
node scripts/build.js prod
```

构建会：
1. 按白名单拷贝到 `dist/prod`
2. 剔除 `pages/assistant`、`pages/insight`、`pages/index`、`pages/share` 与 `utils/ai.js`、`utils/sse.js`、`utils/insight*.js`
3. 剥离所有 `@dev:begin` / `@dev:end` 标记块
4. 重写 `app.json` 的 `pages`
5. 残留关键词校验（AI 字样、模型服务商、AI 页面路由等），命中即构建失败

然后：开发者工具 → 导入项目 → 选 `dist/prod` → 上传。

### 只改线上（不碰 AI）的代码标记规则

需要区分环境的片段用注释包裹，构建时整块删除：

```html
<!-- @dev:begin -->
<view>只在开发版显示的模块</view>
<!-- @dev:end -->
```

```js
/* @dev:begin */
onDevOnly() {}
/* @dev:end */
```

## 目录约定

- `pages/diary` 日记（本地存储）
- `pages/travel` 旅行足迹地图（canvas + 行政区划边界）
- `pages/travel/list` 足迹清单（省级分组、覆盖率、点条目回地图定位）
- `pages/my` 我的（数据概览、隐私指引）
- `pages/assistant`、`pages/insight` AI 能力，**仅 dev**
