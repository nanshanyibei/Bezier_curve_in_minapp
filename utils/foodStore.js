/**
 * 今天吃什么 · 菜品存储与查询
 *
 * 架构：
 *   预置菜品 → 云端 foods 集合（权限：所有用户可读），本地 storage 7 天 TTL 缓存
 *   用户数据 → 云端 food_favorites / food_history / food_custom 集合（权限：仅创建者可读写，靠 _openid 隔离）
 *   本地 storage 存用户数据快照，先写本地（即时反馈），异步推云端
 *
 * 降级：云端不可用时全部走本地 storage，功能不降级
 */
const cb = require('./cb');

// ---------- storage key ----------
const K_SEED_CACHE = 'food.seed.cache';      // 预置菜 TTL 缓存
const K_FAVORITES = 'food.favorites';         // 收藏 { v: 1, ids: [], updatedAt }
const K_HISTORY = 'food.history';             // 历史 { v: 1, picks: [{ id, pickedAt }], updatedAt }
const K_CUSTOM = 'food.custom_dishes';        // 自定义 { v: 1, dishes: [{...dish}], updatedAt }

const SEED_TTL = 7 * 24 * 3600 * 1000;         // 预置菜缓存 7 天
const HISTORY_MAX = 30;                        // 历史上限 30 条
const CLOUD_TIMEOUT = 6000;                    // 云端拉取超时 6s，超时降级本地缓存

// ---------- 内存态 ----------
let _readyPromise = null;
let _seedDishes = null;    // 预置菜内存缓存
let _customDishes = null;  // 自定义菜内存缓存

// ---------- 工具 ----------
function loadJSON(key) {
  try { return wx.getStorageSync(key) || null; } catch (e) { return null; }
}
function saveJSON(key, val) {
  try { wx.setStorageSync(key, val); } catch (e) { /* 空间满则放弃 */ }
}
function uid(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** 云端拉取带超时保护（传 thunk，避免同步抛错逃出 Promise） */
function withTimeout(fn, ms, fallback) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; resolve(fallback); }
    }, ms);
    let p;
    try {
      p = fn();
    } catch (e) {
      clearTimeout(timer);
      resolve(fallback);
      return;
    }
    if (!p || typeof p.then !== 'function') {
      clearTimeout(timer);
      resolve(fallback);
      return;
    }
    p.then((v) => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolve(v);
    }).catch(() => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolve(fallback);
    });
  });
}

// ---------- 预置菜（云端拉 + 本地 TTL 缓存） ----------
function readSeedCache() {
  try {
    const c = wx.getStorageSync(K_SEED_CACHE);
    if (c && c.dishes && Date.now() - c.ts < SEED_TTL) return c.dishes;
  } catch (e) { /* ignore */ }
  return null;
}
function writeSeedCache(dishes) {
  try { wx.setStorageSync(K_SEED_CACHE, { ts: Date.now(), dishes }); } catch (e) { /* ignore */ }
}

function normalizeDish(d) {
  if (!d) return null;
  return {
    id: d.id || d._id || '',
    name: d.name || '',
    tags: Array.isArray(d.tags) ? d.tags : [],
    difficulty: d.difficulty || 1,
    timeMinutes: d.timeMinutes || 30,
    emoji: d.emoji || '🥗',
    ingredients: Array.isArray(d.ingredients) ? d.ingredients : [],
    steps: Array.isArray(d.steps) ? d.steps : [],
    _isCustom: false
  };
}

function loadSeedFromCloud() {
  const cached = readSeedCache();
  // 云端未配置时直接用本地缓存，不发请求
  if (typeof cb.envConfigured === 'function' && !cb.envConfigured()) {
    return Promise.resolve(cached || []);
  }
  return withTimeout(
    () => cb.fetchAll('foods'),
    CLOUD_TIMEOUT,
    null
  ).then((docs) => {
    if (docs && docs.length) {
      const dishes = docs.map(normalizeDish).filter((d) => d && d.id && d.name);
      writeSeedCache(dishes);
      return dishes;
    }
    // 云端不可用或空，降级用本地旧缓存
    const cached = readSeedCache();
    return cached || [];
  });
}

// ---------- 用户数据本地读写 ----------
function loadLocalFavorites() {
  const d = loadJSON(K_FAVORITES);
  return (d && d.ids) ? d.ids : [];
}
function saveLocalFavorites(ids) {
  saveJSON(K_FAVORITES, { v: 1, ids: ids, updatedAt: Date.now() });
}

function loadLocalHistory() {
  const d = loadJSON(K_HISTORY);
  return (d && d.picks) ? d.picks : [];
}
function saveLocalHistory(picks) {
  saveJSON(K_HISTORY, { v: 1, picks: picks, updatedAt: Date.now() });
}

function loadLocalCustom() {
  const d = loadJSON(K_CUSTOM);
  return (d && d.dishes) ? d.dishes : [];
}
function saveLocalCustom(dishes) {
  saveJSON(K_CUSTOM, { v: 1, dishes: dishes, updatedAt: Date.now() });
}

// ---------- 用户数据云端 pull ----------
function pullUserCloud() {
  const p = cb.ready().then(() => {
    if (!cb.envConfigured()) return;

    // 收藏：拉全部，按 updatedAt 新者胜合并
    cb.listDocs('food_favorites').then((docs) => {
      if (!docs) return;
      const localIds = loadLocalFavorites();
      const localSet = {};
      docs.forEach((d) => { if (d.dishId) localSet[d.dishId] = true; });
      const merged = Array.from(new Set([...localIds, ...Object.keys(localSet)]));
      saveLocalFavorites(merged);
    }).catch(() => { /* 云端不可用，保留本地 */ });

    // 历史：云端与本地合并去重（避免云端为空时把本地记录冲掉）
    cb.listDocs('food_history').then((docs) => {
      if (!docs || !docs.length) return;
      const cloudItems = docs.map((d) => ({ id: d.dishId, pickedAt: d.pickedAt || 0 }))
        .filter((x) => x.id);
      const seen = {};
      const merged = [...loadLocalHistory(), ...cloudItems]
        .sort((a, b) => b.pickedAt - a.pickedAt)
        .filter((x) => {
          const k = x.id + '_' + x.pickedAt;
          if (seen[k]) return false;
          seen[k] = 1;
          return true;
        })
        .slice(0, HISTORY_MAX);
      saveLocalHistory(merged);
    }).catch(() => { /* 保留本地 */ });

    // 自定义：云端有数据才覆盖本地（云端是权威，但空集合不清空本地）
    cb.listDocs('food_custom').then((docs) => {
      if (!docs || !docs.length) return;
      const dishes = docs.map((d) => {
        const base = normalizeDish(d);
        if (!base) return null;
        base.id = d.id || d._id;
        base._isCustom = true;
        return base;
      }).filter(Boolean);
      if (dishes.length) {
        saveLocalCustom(dishes);
        _customDishes = dishes;
      }
    }).catch(() => { /* 保留本地 */ });
  }).catch(() => { /* cb.ready 失败 */ });
}

// ---------- 对外 API ----------

/** 初始化：拉预置菜 → 写缓存；pull 用户数据 */
function ready() {
  if (_readyPromise) return _readyPromise;

  _readyPromise = new Promise((resolve) => {
    const cached = readSeedCache();
    if (cached) _seedDishes = cached;

    // 本地自定义菜先就位，保证离线也有内容
    _customDishes = loadLocalCustom();

    // 预置菜：只发起一次请求；拉到后覆盖内存与缓存
    const seedTask = loadSeedFromCloud().then((fresh) => {
      if (fresh && fresh.length) _seedDishes = fresh;
      // 空池时允许下次调用重试（比如刚导入种子数据）
      if (!_seedDishes || !_seedDishes.length) _readyPromise = null;
    });

    // 用户数据异步合并，不阻塞首屏
    pullUserCloud();

    if (cached) {
      // 有缓存立刻可用，云端在后台刷新
      resolve(true);
    } else {
      seedTask.then(() => resolve(true));
    }
  });

  return _readyPromise;
}

/** 预置 + 自定义 合并 */
function getAllDishes() {
  const seed = _seedDishes || readSeedCache() || [];
  const custom = _customDishes || loadLocalCustom();
  // 自定义菜 id 前缀 c_，不会和预置菜 f_ 冲突
  return [...seed, ...custom];
}

/** 按 tag 交集过滤（tags 空数组 = 全部） */
function getDishesByTags(tags) {
  if (!tags || !tags.length) return getAllDishes();
  const all = getAllDishes();
  return all.filter((d) => {
    const dishTags = d.tags || [];
    return tags.every((t) => dishTags.indexOf(t) >= 0);
  });
}

/** 按 id 取单条 */
function getDishById(id) {
  if (!id) return null;
  return getAllDishes().find((d) => d.id === id) || null;
}

/**
 * 随机抽取：均匀分布一次性决定 index
 * UI 层自己做快速切换动画，最终回填此函数返回的 final dish
 */
function randomPick(tags) {
  const pool = getDishesByTags(tags);
  if (!pool.length) return null;
  const idx = Math.floor(Math.random() * pool.length);
  return pool[idx];
}

// ---------- 收藏 ----------
function isFavorite(id) {
  return loadLocalFavorites().indexOf(id) >= 0;
}

function toggleFavorite(id) {
  const ids = loadLocalFavorites();
  const idx = ids.indexOf(id);
  let newList;
  if (idx >= 0) {
    ids.splice(idx, 1);
    newList = ids;
  } else {
    newList = [id, ...ids];
  }
  saveLocalFavorites(newList);

  // 异步推云端
  if (idx >= 0) {
    cb.removeDoc('food_favorites', id);
  } else {
    cb.setDoc('food_favorites', id, {
      dishId: id,
      createdAt: Date.now()
    });
  }

  return idx < 0; // 返回新状态：true=已收藏
}

function getFavorites() {
  const ids = loadLocalFavorites();
  return ids.map((id) => getDishById(id)).filter(Boolean);
}

// ---------- 历史 ----------
function pushHistory(id) {
  if (!id) return;
  const picks = loadLocalHistory();
  const now = Date.now();
  // 避免最后一条重复
  if (picks.length && picks[0].id === id) picks.shift();
  picks.unshift({ id: id, pickedAt: now });
  while (picks.length > HISTORY_MAX) picks.pop();
  saveLocalHistory(picks);

  // 异步推云端（逐条写，用时间戳做业务键避免冲突）
  cb.setDoc('food_history', String(now), {
    dishId: id,
    pickedAt: now
  });
}

function getHistory() {
  const picks = loadLocalHistory();
  return picks.map((p) => ({
    dish: getDishById(p.id),
    pickedAt: p.pickedAt
  })).filter((h) => h.dish);
}

// ---------- 自定义菜品 ----------
function addCustomDish(dish) {
  const id = 'c_' + Date.now().toString(36);
  const full = Object.assign({
    id: id,
    name: '',
    tags: [],
    difficulty: 1,
    timeMinutes: 30,
    emoji: '🥗',
    ingredients: [],
    steps: [],
    createdAt: Date.now(),
    _isCustom: true
  }, dish);

  const list = loadLocalCustom();
  list.unshift(full);
  saveLocalCustom(list);
  _customDishes = list;

  // 推云端
  cb.setDoc('food_custom', id, full);

  return full;
}

function updateCustomDish(id, patch) {
  const list = loadLocalCustom();
  const idx = list.findIndex((d) => d.id === id);
  if (idx < 0) return null;
  list[idx] = Object.assign({}, list[idx], patch, { updatedAt: Date.now() });
  saveLocalCustom(list);
  _customDishes = list;

  cb.setDoc('food_custom', id, list[idx]);
  return list[idx];
}

function removeCustomDish(id) {
  const list = loadLocalCustom().filter((d) => d.id !== id);
  saveLocalCustom(list);
  _customDishes = list;
  cb.removeDoc('food_custom', id);
}

// ---------- 其他 ----------

/** 全量 tag 并集 — 预置 + 自定义 */
function getAllTags() {
  const set = {};
  getAllDishes().forEach((d) => {
    (d.tags || []).forEach((t) => { set[t] = 1; });
  });
  // 固定顺序：先菜系，再做法，最后荤素
  const cuisines = ['川菜', '粤菜', '湘菜', '江浙菜', '家常菜'];
  const methods = ['快手菜', '炒菜', '炖菜', '蒸菜', '汤类', '主食'];
  const others = ['荤菜', '素菜', '半荤半素'];
  const rest = Object.keys(set).filter((t) =>
    cuisines.indexOf(t) < 0 && methods.indexOf(t) < 0 && others.indexOf(t) < 0
  );
  return [...cuisines, ...methods, ...others, ...rest].filter((t) => set[t]);
}

function stats() {
  const all = getAllDishes();
  return {
    total: all.length,
    favoriteCount: loadLocalFavorites().length,
    customCount: loadLocalCustom().length,
    historyCount: loadLocalHistory().length
  };
}

function clearAll() {
  try { wx.removeStorageSync(K_FAVORITES); } catch (e) { /* ignore */ }
  try { wx.removeStorageSync(K_HISTORY); } catch (e) { /* ignore */ }
  try { wx.removeStorageSync(K_CUSTOM); } catch (e) { /* ignore */ }
  _customDishes = [];
  // 预置菜缓存保留（不影响）
}

module.exports = {
  ready,
  getAllDishes,
  getDishesByTags,
  getDishById,
  randomPick,

  isFavorite,
  toggleFavorite,
  getFavorites,

  pushHistory,
  getHistory,

  addCustomDish,
  updateCustomDish,
  removeCustomDish,

  getAllTags,
  stats,
  clearAll
};
