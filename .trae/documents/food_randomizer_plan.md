# 今天吃什么 · 家常菜随机选 实现计划（v2 · 数据上云版）

> 对应 MRD：`docs/mrd-food-randomizer.md`
> v2 改动：预置菜品数据从前端 JS 静态文件 → 云端数据库集合 `foods`
> 范围：M1（抽菜 MVP + 详情）+ M2（收藏/历史/自定义 + 云端同步）

---

## Repository Research

### 已有模式与约束

| 项 | 发现 | 影响 |
|---|---|---|
| 页面结构 | 每页面 4 文件（`.js` / `.json` / `.wxml` / `.wxss`），`.js` 里 `Page({})`，`.wxml` 顶部 `<view class="page">` 容器 | 新增页面沿用此骨架 |
| 全局主题 | `app.wxss` 定义 CSS 变量 `--bg: #16161c` / `--accent: #6ea8fe` / `.card` / `.btn` / `.btn-ghost` / `.text-dim` / `.stats-row` 等通用类 | 所有页面样式基于这些变量，不新建色板 |
| Store 模块 | `utils/travelStore.js` 为标杆：CommonJS，本地 storage 即时落盘 + `pullCloud` 异步合并 | `utils/foodStore.js` 必须对齐此风格 |
| **CloudBase 接入** | **已迁移到 `wx.cloud.database()` 客户端直查**（非旧 HTTP 网关），三种权限档：①公开只读（`attractions`）②用户私有（`marks`/`diaries`/`chats` 靠 _openid 自动隔离）③未配置时本地降级 | **预置菜品用①，用户收藏/历史/自定义用②** |
| **cb.js 能力** | `fetchAll(name, filter)` 通用分页拉全集合；`listDocs/setDoc/removeDoc` 通用集合 CRUD；`fetchAttractions` 带本地 TTL 缓存（`cacheKey/readCache/writeCache`） | foodStore 复用 `fetchAll` + 自己加缓存层 |
| 构建脚本 | `scripts/build.js`：`PROD_PAGES` 白名单决定生产包页面，`FORBIDDEN` 关键词列表（siliconflow/deepseek/AI/人工智能 等）命中失败 | food 模块无 AI 关键词，但**必须把新页面加入 `PROD_PAGES`** |
| tabBar | 已满 5 项，不能再加 | 入口放「我的」页卡片 |
| 构建体积门禁 | 主包 ≤ 1840 KB | 去掉预置数据后 food 模块前端 JS 仅 ~20KB，无风险 |

---

## 数据架构

### 云端集合

| 集合名 | 权限档 | 用途 | 文档结构 |
|---|---|---|---|
| **`foods`** | 所有用户可读 | 预置菜品（~80 道），服务端种子数据 | `{ id, name, tags[], difficulty, timeMinutes, ingredients[], steps[], emoji }` |
| `food_favorites` | 仅创建者可读写 | 用户收藏列表（按 _openid 隔离） | `{ favId: '<userKey>_<dishId>', dishId, createdAt }` |
| `food_history` | 仅创建者可读写 | 用户历史抽取记录 | `{ pickId: '<userKey>_<timestamp>', dishId, pickedAt }` |
| `food_custom` | 仅创建者可读写 | 用户自定义菜品 | `{ customId: '<userKey>_<dishId>', id, name, tags[], difficulty, timeMinutes, ingredients[], steps[], emoji, createdAt }` |

**`foods` 集合**：首次部署由种子脚本写入（或云开发控制台手动导入 JSON），只读不改。

**收藏/历史/自定义**：每条一个文档，`_id` 由 `cb.resolveId()` 生成 `<userKey>_<业务键>` 避免多人撞 id（同 marks/diaries 模式）。用户本地 storage 存最近快照，每次打开从云端 pull 合并。

### 缓存策略（参考 attractions）

预置菜品列表 `foods` 不常变，用 **本地 storage TTL 缓存**：

```js
// foodStore.js 内部
const FOOD_CACHE_KEY = 'food.seed.cache';
const CACHE_TTL = 7 * 24 * 3600 * 1000; // 7 天，预置菜品几乎不改

function loadSeedDishes() {
  // 1. 本地缓存命中 → 直接返回
  const cached = wx.getStorageSync(FOOD_CACHE_KEY);
  if (cached && cached.dishes && Date.now() - cached.ts < CACHE_TTL) return cached.dishes;

  // 2. 缓存 miss → 从云端拉全量 → 写缓存 → 返回
  return cb.fetchAll('foods').then((docs) => {
    const dishes = docs.map(normalizeDish);
    wx.setStorageSync(FOOD_CACHE_KEY, { ts: Date.now(), dishes });
    return dishes;
  }).catch(() => cached ? cached.dishes : []); // 云端挂了兜底用旧缓存
}
```

用户数据（收藏/历史/自定义）每次 `onShow` 都 pullCloud，不做长 TTL 缓存，保证数据新鲜。

---

## Files and Modules

### 新建文件

| # | 路径 | 职责 |
|---|---|---|
| **N0** | **`scripts/seed-foods.js`** | **种子脚本：把 80+ 道预置菜品写入 `foods` 集合**（Node 脚本，用 wx.cloud.admin SDK 或直接导入 JSON，首次部署后可删除） |
| N1 | `utils/foodStore.js` | **核心**：云端拉取预置菜 + 本地/云端管理收藏/历史/自定义 + 筛选 + 随机抽取 |
| N2 | `pages/food/food.*` | 主页面（抽菜动效 + 筛选 + 快捷入口） |
| N3 | `pages/food/detail/detail.*` | 详情页 |
| N4 | `pages/food/favorites/favorites.*` | 收藏列表页 |
| N5 | `pages/food/history/history.*` | 历史记录页 |
| N6 | `pages/food/custom/edit.*` | 自定义添加/编辑表单 |

### 修改文件

| # | 路径 | 改动 |
|---|---|---|
| M1 | `app.json` | 追加 5 个 food 页面路径到 `pages` 数组 |
| M2 | `scripts/build.js` | `PROD_PAGES` 追加 5 个 food 页面 |
| M3 | `pages/my/my.js` | require foodStore + `refresh()` 追加 foodFavCount + 新增 `onOpenFood` |
| M4 | `pages/my/my.wxml` | 数据概览下插入「今天吃什么」`.card row` 入口卡 |

### 不新建 / 不修改

- ❌ **不** `assets/data/foods.js`（预置数据全部上云，前端不塞大段静态 JSON）
- ❌ **不** `utils/cb.js` 扩展 — foodStore 直接复用 cb 已有的 `fetchAll / listDocs / setDoc / removeDoc`
- ❌ **不** `app.wxss` — 全局主题已足够，food 页面只消费现有 CSS 变量

---

## Implementation Steps

### Step 1: 云端集合准备 + 种子数据脚本

**创建集合**（云开发控制台手动操作）：
- `foods`：权限 → 「所有用户可读，仅创建者可读写」（预置数据写入用管理员账号）
- `food_favorites` / `food_history` / `food_custom`：权限 → 「仅创建者可读写」（默认权限）

**`scripts/seed-foods.js`**（一次性脚本，Node 运行，写 80+ 道到 `foods` 集合）：
```js
// 用 wx.cloud SDK 直接写入（云函数环境或本地 admin SDK）
// 或导出 JSON 手动导入云开发控制台
const dishes = [ /* 80+ 道菜 */ ];
// 批量写入 foods 集合
```

> 脚本写好后可删除，不进生产包。预置数据一次写入永久生效。

### Step 2: `utils/foodStore.js`

**核心职责**：
1. 拉取云端预置菜品 + 本地缓存（`cb.fetchAll('foods')` + TTL 7 天 storage）
2. 合并预置 + 用户自定义菜品（自定义走 `cb.listDocs('food_custom')`）
3. 收藏 / 历史 / 自定义的本地 storage + 云端双向同步
4. 筛选（tags 交集）+ 随机抽取（`Math.floor` 均匀分布）

**storage key**（用户数据）：

| key | 说明 |
|---|---|
| `food.favorites` | `{ v: 1, ids: [], updatedAt }` — 收藏 id 列表 |
| `food.history` | `{ v: 1, picks: [{ id, pickedAt }], updatedAt }` — 最近 30 次 |
| `food.custom_dishes` | `{ v: 1, dishes: [], updatedAt }` — 本地自定义快照 |
| `food.seed.cache` | `{ ts, dishes }` — 预置菜品云端缓存 |

**API 列表**：

```js
module.exports = {
  // 初始化 + 数据加载
  ready(),                 // Promise — 拉云端预置菜 → 写缓存；同时拉用户私有集合
  getAllDishes(),          // 预置 + 自定义 合并
  getDishesByTags(tags),   // 多 tag 交集过滤
  getDishById(id),         // 按 id 取单条
  randomPick(tags),        // 先定均匀随机 index → 返回 final dish

  // 收藏（本地 storage + 云端双写）
  isFavorite(id),
  toggleFavorite(id),      // Promise<boolean>
  getFavorites(),

  // 历史（本地 + 云端双写，限 30 条）
  pushHistory(id),
  getHistory(),

  // 自定义菜品（本地 + 云端双写）
  addCustomDish(dish),
  updateCustomDish(dishId, patch),
  removeCustomDish(dishId),

  // 其他
  ALL_TAGS,                // 常量：预置菜 + 自定义菜的 tag 并集，筛选用
  stats(),                 // { total, favoriteCount, customCount, historyCount }
  clearAll(),              // 清所有本地数据（云端集合逐条删）
};
```

**`randomPick` 实现**：
```js
function randomPick(tags) {
  const pool = getDishesByTags(tags);
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}
```
UI 层自己做 `setInterval` 200ms × 10 次的快速切换动画，最终回填 `randomPick` 预先决定的结果。

**同步策略**：
- `ready()`（food 页面 `onShow` 时调用）：`cb.fetchAll('foods')` 拉预置菜 → 写本地 TTL 缓存；`cb.listDocs('food_favorites'/'food_history'/'food_custom')` 拉用户私有集合 → 按 `updatedAt` 新者胜合并入本地 storage
- 写操作（toggleFavorite / pushHistory / addCustomDish）：**先写本地 storage（即时反馈）** → 异步 `cb.setDoc()` 推云端 → 失败静默（下次 pullCloud 兜底）
- 云端不可用时：全部走本地 storage，功能不降级

### Step 3: 4 个页面实现

主页面、详情页、收藏页、历史页、自定义编辑页 — 骨架与上一版计划完全一致。

**UI 变化**（v1→v2 不变）：
- 图片：MVP 用 emoji 占位（每道菜带 `emoji` 字段从云端返回）
- 筛选 chip 行 / 菜品卡片 / 双按钮 / 底部快捷入口 — 全复用 `.card` / `.btn` / `.btn-ghost` / `.text-dim` 等全局类

**WXML 核心结构**（主页面）：
```
<view class="page">
  <view class="hero"> 标题 + 副标题 </view>
  <scroll-view scroll-x class="tag-bar"> 筛选 chips </scroll-view>
  <view class="card dish-card"> emoji + 菜名 + 难度/耗时 + tag chips </view>
  <view class="btn-row"> 🔀随机抽菜 / ✓就它了 </view>
  <view class="bottom-row"> 详情 / 收藏 / 历史 / 我的菜 </view>
</view>
```

**JS 生命周期**：
```js
Page({
  onShow() {
    foodStore.ready().then(() => {
      this.refresh();
    });
  },
  refresh() {
    // 从 foodStore 读数据 → setData
    // 预置菜已在 ready() 时从云端拉到本地缓存
    // 统计数实时读 foodStore.stats()
  },
  onRandomTap() {
    const final = foodStore.randomPick(this.data.activeTags);
    // setInterval 动画...回填 final
    foodStore.pushHistory(final.id); // 异步，不阻塞 UI
  }
});
```

### Step 4: 入口挂载 + 注册 + 白名单

**`pages/my/my.wxml`**（数据概览 stats-row 之后）：
```xml
<view class="card row" bindtap="onOpenFood">
  <view class="row-main">
    <view class="row-title">今天吃什么</view>
    <view class="text-dim">随机抽一道家常菜 · 已收藏 {{foodFavCount}} 道</view>
  </view>
  <text class="row-arrow">›</text>
</view>
```

**`pages/my/my.js`**：
```js
const foodStore = require('../../utils/foodStore');
// data 追加 foodFavCount: 0
// refresh() 追加 const f = foodStore.stats(); this.setData({ foodFavCount: f.favoriteCount })
// onOpenFood() { wx.navigateTo({ url: '/pages/food/food' }) }
```

**`app.json`** → pages 追加：
```
"pages/food/food",
"pages/food/detail/detail",
"pages/food/favorites/favorites",
"pages/food/history/history",
"pages/food/custom/edit"
```

**`scripts/build.js`** → `PROD_PAGES` 追加同上 5 条。

---

## Dependencies and Considerations

1. **必须先部署种子数据**：如果 `foods` 集合为空，前端抽菜一直 toast「暂无菜品」。seed 脚本或控制台手动导入 JSON 必须在开发环境先跑通。
2. **预置菜品 emoji 字段**：每道菜带一个 emoji 字符串（如 `'🥘'` / `'🌶️'` / `'🦐'`），前端直接渲染，MVP 不配真实图片。
3. **foodStore.ready() 必须 Promise 化**：因为拉云端是异步的，页面 `onShow` 里要 `await ready()` 再 render；云端不可用时降级走本地缓存，不阻塞页面。
4. **cb.fetchAll 客户端 20 条限制**：foods 预置 80+ 道菜，`fetchAll` 内部已做分页循环（`skip+limit(PAGE_SIZE)`），直接用不用改。
5. **foodStore 不 require cb.js 以外的任何云端依赖**：用户私有集合 CRUD 全走 `listDocs/setDoc/removeDoc`，和 travelStore/diaryStore 同模式。
6. **`@dev` 标记**：foodStore / food 各页面 / seed 脚本完全不含 AI 关键词，`FORBIDDEN` 列表不命中，prod 构建零剥离影响。
7. **主包体积**：预置数据已在云端，前端 food 模块 JS 估算 ≤ 20KB（foodStore + 5 个页面骨架），远低于 1840KB 上限。

---

## Validation

实现完成后必须做：

1. **云开发控制台**：
   - [ ] `foods` 集合有 80+ 条文档，权限档「所有用户可读」
   - [ ] `food_favorites` / `food_history` / `food_custom` 已创建，权限档「仅创建者可读写」

2. **开发者工具模拟器**：
   - [ ] 首次打开 food 页面：foodStore.ready() 拉云端预置菜 → 进入缓存（storage 能看到 `food.seed.cache`）
   - [ ] 抽菜：动效 ≈2s → 落定菜品 → 历史自动写入
   - [ ] 筛选：tag 交集正确，空池有 toast
   - [ ] 收藏：详情页心形按钮 → 本地即时生效 + 云端异步写入
   - [ ] 自定义：添加 → 立即可抽 → 云端写入 → 杀进程重开仍在
   - [ ] 切换账号测试（换 openid）：各用户私有数据互相隔离

3. **生产包构建**：
   - [ ] `node scripts/build.js prod` 不报错
   - [ ] 构建产物包含 5 个 food 页面目录
   - [ ] FORBIDDEN 关键词校验通过
   - [ ] 主包体积 ≤ 1840KB

---

## Risks

| 风险 | 等级 | 处理 |
|---|---|---|
| 云端 `foods` 集合没数据 → 前端空池 | 高 | seed 脚本先跑，开发环境确认 `food.seed.cache` 写入后再测功能 |
| 用户网络差 → 预置菜拉取慢 | 中 | ready() 内做超时兜底：10s 没拉到就用本地上次缓存（`cached.dishes`），保证离线可用 |
| 预置菜改了（加新菜/修数据）→ 用户缓存过期前看不到 | 低 | 把 TTL 从 7 天调短（如 1 天）或加版本号比较；MVP 先 7 天，预置菜极少改 |
| `food_history` 每次 onShow 都拉全量 → 多次往返 | 低 | 30 条上限，fetchAll 分页也才 2 页，完全不是瓶颈 |
| 生产包忘记加 PROD_PAGES | 中 | Validation 环节构建后 grep `dist/prod/app.json` 的 pages 数组确认 |
| 云端集合权限配错（foods 设成私有）→ 所有人查不到预置菜 | 中 | 部署 checklist 明确标注 4 个集合 + 2 种权限档；控制台截图验收 |
