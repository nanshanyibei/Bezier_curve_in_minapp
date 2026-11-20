/**
 * 电子衣橱存储（key: wardrobe.items）
 * 结构 v1：{ v: 1, items: [entry] }
 * entry = {
 *   id:        'w_<createdAt>_<rand>'    // 一物一条
 *   name:      '白色针织开衫'             // 必填，≤40 字
 *   category:  'top'                     // top/bottom/outer/shoes/bag/accessory
 *   color:     '米白'                     // 选填，≤20 字
 *   season:    'all'                     // all/spring/summer/autumn/winter
 *   note:      ''                        // 选填，≤500 字
 *   photo:     { fileID, local, w, h, failed } | null   // 单张封面图
 *   createdAt / updatedAt: number
 *   synced:    boolean                   // 仅本地用，不上云
 * }
 *
 * 设计要点：
 * - 本地优先：所有操作即时落 storage，离线完全可用。
 * - 云端 wardrobe 集合按 _openid 隔离，pullCloud 按 updatedAt 新者胜合并。
 * - 图片先落本地永久路径再异步上传换 fileID，失败不影响保存与展示。
 */
const cb = require('./cb');

const KEY = 'wardrobe.items';
const NAME_MAX = 40;
const COLOR_MAX = 20;
const NOTE_MAX = 500;

const CATEGORIES = [
  { key: 'top', label: '上装', emoji: '👕' },
  { key: 'bottom', label: '下装', emoji: '👖' },
  { key: 'outer', label: '外套', emoji: '🧥' },
  { key: 'shoes', label: '鞋', emoji: '👟' },
  { key: 'bag', label: '包', emoji: '👜' },
  { key: 'accessory', label: '配饰', emoji: '🧣' }
];

const SEASONS = [
  { key: 'all', label: '四季' },
  { key: 'spring', label: '春' },
  { key: 'summer', label: '夏' },
  { key: 'autumn', label: '秋' },
  { key: 'winter', label: '冬' }
];

function loadAll() {
  const d = wx.getStorageSync(KEY);
  if (d && d.v === 1 && Array.isArray(d.items)) return d;
  return { v: 1, items: [] };
}

function saveAll(d) {
  try {
    wx.setStorageSync(KEY, d);
  } catch (e) {
    // storage 满了：图片本身在文件系统，这里只存元数据，正常不会满
    console.error('[wardrobe] 本地存储写入失败:', (e && e.message) || e);
  }
}

function rand(n) {
  return Math.random().toString(36).slice(2, 2 + (n || 5));
}

function makeId(createdAt) {
  return 'w_' + createdAt + '_' + rand(5);
}

function normalizePhoto(p) {
  if (!p || (!p.fileID && !p.local)) return null;
  return {
    fileID: p.fileID || '',
    local: p.local || '',
    w: p.w || 0,
    h: p.h || 0,
    failed: !!p.failed
  };
}

/** 清洗一条 entry（本地 / 云端进来都要过这一道）；名称为空视为无效 */
function normalize(raw) {
  if (!raw) return null;
  const name = String(raw.name || '').trim().slice(0, NAME_MAX);
  if (!name) return null;
  const category = CATEGORIES.some(function (c) { return c.key === raw.category; })
    ? raw.category : 'top';
  const season = SEASONS.some(function (s) { return s.key === raw.season; })
    ? raw.season : 'all';
  return {
    id: String(raw.id || ''),
    name: name,
    category: category,
    color: String(raw.color || '').trim().slice(0, COLOR_MAX),
    season: season,
    note: String(raw.note || '').slice(0, NOTE_MAX),
    photo: normalizePhoto(raw.photo),
    createdAt: raw.createdAt || 0,
    updatedAt: raw.updatedAt || 0,
    synced: raw.synced === true
  };
}

/** 按创建时间倒序（同刻按更新时间倒序），新加的在前 */
function list() {
  return loadAll().items.slice().sort(function (a, b) {
    if (a.createdAt !== b.createdAt) return (b.createdAt || 0) - (a.createdAt || 0);
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
}

function get(id) {
  const key = String(id);
  const hit = loadAll().items.find(function (e) { return e.id === key; });
  return hit || null;
}

/** 云文档字段：不带 local / failed / synced */
function toPayload(entry) {
  return {
    id: entry.id,
    name: entry.name,
    category: entry.category,
    color: entry.color,
    season: entry.season,
    note: entry.note,
    photo: entry.photo
      ? { fileID: entry.photo.fileID || '', w: entry.photo.w || 0, h: entry.photo.h || 0 }
      : null,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt
  };
}

function patchLocal(id, fields) {
  const d = loadAll();
  const idx = d.items.findIndex(function (e) { return e.id === String(id); });
  if (idx < 0) return null;
  d.items[idx] = Object.assign({}, d.items[idx], fields);
  saveAll(d);
  return d.items[idx];
}

/** 推一条到云端（失败静默，synced=false 留给下次 launch 补推） */
function pushOne(entry) {
  if (!entry) return;
  cb.setDoc('wardrobe', entry.id, toPayload(entry)).then(function (ok) {
    patchLocal(entry.id, { synced: !!ok });
  });
}

/** 新建/更新；名称为空返回 null（等同无效） */
function save(entry) {
  const d = loadAll();
  const now = Date.now();
  const input = Object.assign({}, entry);
  if (!input.id) input.id = makeId(now);
  const idx = d.items.findIndex(function (e) { return e.id === String(input.id); });
  if (idx >= 0) {
    input.createdAt = d.items[idx].createdAt || input.createdAt || now;
  } else if (!input.createdAt) {
    input.createdAt = now;
  }
  input.updatedAt = now;
  const clean = normalize(input);
  if (!clean) return null;
  if (idx >= 0) d.items[idx] = clean;
  else d.items.push(clean);
  saveAll(d);
  pushOne(clean);
  return clean;
}

function remove(id) {
  const key = String(id);
  const d = loadAll();
  const idx = d.items.findIndex(function (e) { return e.id === key; });
  if (idx < 0) return false;
  const gone = d.items[idx];
  d.items.splice(idx, 1);
  saveAll(d);
  cb.removeDoc('wardrobe', key);
  // 云存储图片一并清理（失败静默，容忍孤儿文件）
  if (gone.photo && gone.photo.fileID) cb.deleteFiles([gone.photo.fileID]);
  return true;
}

/** { total, byCategory: { top: n, ... } } */
function stats() {
  const items = loadAll().items;
  const byCategory = {};
  CATEGORIES.forEach(function (c) { byCategory[c.key] = 0; });
  items.forEach(function (e) {
    if (byCategory[e.category] !== undefined) byCategory[e.category]++;
  });
  return { total: items.length, byCategory: byCategory };
}

/**
 * 拉云端按 updatedAt 新者胜合并，返回 { items, changed }
 * 云端不可用时 changed=false
 */
function pullCloud() {
  return cb.listDocs('wardrobe').then(function (docs) {
    if (!docs || !docs.length) return { items: loadAll().items, changed: false };
    const d = loadAll();
    const map = {};
    d.items.forEach(function (e) { map[e.id] = e; });
    let changed = false;
    docs.forEach(function (raw) {
      const remote = normalize(raw);
      if (!remote) return;
      const cur = map[remote.id];
      if (cur && (cur.updatedAt || 0) >= remote.updatedAt) return;
      // 云端没有本地临时路径，同 fileID 时保留本地图，避免刚存的图变成灰块
      if (cur && cur.photo && remote.photo && !remote.photo.local
        && cur.photo.fileID && cur.photo.fileID === remote.photo.fileID) {
        remote.photo.local = cur.photo.local || '';
      }
      remote.synced = true;
      map[remote.id] = remote;
      changed = true;
    });
    if (changed) {
      d.items = Object.keys(map).map(function (k) { return map[k]; });
      saveAll(d);
    }
    return { items: d.items, changed: changed };
  }).catch(function () {
    return { items: loadAll().items, changed: false };
  });
}

/** 补推所有未同步成功的条目（启动时调一次） */
function syncPending() {
  const pending = loadAll().items.filter(function (e) { return !e.synced; });
  if (!pending.length) return Promise.resolve(0);
  return Promise.all(pending.map(function (e) {
    return cb.setDoc('wardrobe', e.id, toPayload(e)).then(function (ok) {
      if (ok) patchLocal(e.id, { synced: true });
      return ok ? 1 : 0;
    });
  })).then(function (arr) {
    return arr.reduce(function (a, b) { return a + b; }, 0);
  });
}

module.exports = {
  KEY, NAME_MAX, COLOR_MAX, NOTE_MAX, CATEGORIES, SEASONS,
  list, get, save, remove, stats, pullCloud, syncPending
};
