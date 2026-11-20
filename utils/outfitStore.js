/**
 * 搭配存储（key: wardrobe.outfits）
 * 结构 v1：{ v: 1, items: [entry] }
 * entry = {
 *   id:        'o_<createdAt>_<rand>'
 *   name:      '搭配 11月20日 14:30'      // 选填，≤20 字
 *   image:     { fileID, local, failed } | null   // 白底搭配图
 *   items:     [{ id, name, category }]           // 衣物快照，删除衣物不影响这里
 *   createdAt / updatedAt: number
 *   synced:    boolean
 * }
 *
 * 与 wardrobeStore 相同策略：本地优先、云端 wardrobe_outfits 按 _openid 隔离、
 * updatedAt 新者胜、图片 fileID 异步上传、失败静默补同步。
 */
const cb = require('./cb');
const wardrobeStore = require('./wardrobeStore');

const KEY = 'wardrobe.outfits';
const NAME_MAX = 20;
const COLLECTION = 'wardrobe_outfits';
const MAX_ITEMS = 6;

const CATEGORY_KEYS = {};
wardrobeStore.CATEGORIES.forEach(function (c) { CATEGORY_KEYS[c.key] = true; });

function loadAll() {
  const d = wx.getStorageSync(KEY);
  if (d && d.v === 1 && Array.isArray(d.items)) return d;
  return { v: 1, items: [] };
}

function saveAll(d) {
  try {
    wx.setStorageSync(KEY, d);
  } catch (e) {
    console.error('[outfit] 本地存储写入失败:', (e && e.message) || e);
  }
}

function rand(n) {
  return Math.random().toString(36).slice(2, 2 + (n || 5));
}

function makeId(createdAt) {
  return 'o_' + createdAt + '_' + rand(5);
}

function normalizeImage(p) {
  if (!p || (!p.fileID && !p.local)) return null;
  return {
    fileID: p.fileID || '',
    local: p.local || '',
    failed: !!p.failed
  };
}

/** 衣物快照：去重、最多 6 件、保留名称与分类 */
function normalizeItems(raw) {
  const out = [];
  const seen = {};
  (Array.isArray(raw) ? raw : []).forEach(function (it) {
    if (!it) return;
    const id = String(it.id || '');
    const name = String(it.name || '').trim();
    if (!id || !name || seen[id]) return;
    seen[id] = true;
    const category = CATEGORY_KEYS[it.category] ? it.category : 'top';
    out.push({ id: id, name: name, category: category });
  });
  return out.slice(0, MAX_ITEMS);
}

function normalize(raw) {
  if (!raw) return null;
  const name = String(raw.name || '').trim().slice(0, NAME_MAX) || '搭配';
  const items = normalizeItems(raw.items);
  if (!items.length) return null;
  return {
    id: String(raw.id || ''),
    name: name,
    image: normalizeImage(raw.image),
    items: items,
    createdAt: raw.createdAt || 0,
    updatedAt: raw.updatedAt || 0,
    synced: raw.synced === true
  };
}

/** 按创建时间倒序，新搭配在前 */
function list() {
  return loadAll().items.slice().sort(function (a, b) {
    if (a.createdAt !== b.createdAt) return (b.createdAt || 0) - (a.createdAt || 0);
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
}

function get(id) {
  const key = String(id);
  return loadAll().items.find(function (e) { return e.id === key; }) || null;
}

function toPayload(entry) {
  return {
    id: entry.id,
    name: entry.name,
    image: entry.image
      ? { fileID: entry.image.fileID || '' }
      : null,
    items: entry.items.map(function (it) {
      return { id: it.id, name: it.name, category: it.category };
    }),
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

function pushOne(entry) {
  if (!entry) return;
  cb.setDoc(COLLECTION, entry.id, toPayload(entry)).then(function (ok) {
    patchLocal(entry.id, { synced: !!ok });
  });
}

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
  cb.removeDoc(COLLECTION, key);
  if (gone.image && gone.image.fileID) cb.deleteFiles([gone.image.fileID]);
  return true;
}

/**
 * 云端合并：updatedAt 新者胜；同 fileID 时保留本地图片路径
 * 返回 { items, changed }
 */
function pullCloud() {
  return cb.listDocs(COLLECTION).then(function (docs) {
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
      if (cur && cur.image && remote.image && !remote.image.local
        && cur.image.fileID && cur.image.fileID === remote.image.fileID) {
        remote.image.local = cur.image.local || '';
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

function syncPending() {
  const pending = loadAll().items.filter(function (e) { return !e.synced; });
  if (!pending.length) return Promise.resolve(0);
  return Promise.all(pending.map(function (e) {
    return cb.setDoc(COLLECTION, e.id, toPayload(e)).then(function (ok) {
      if (ok) patchLocal(e.id, { synced: true });
      return ok ? 1 : 0;
    });
  })).then(function (arr) {
    return arr.reduce(function (a, b) { return a + b; }, 0);
  });
}

module.exports = {
  KEY, NAME_MAX, COLLECTION, MAX_ITEMS,
  list, get, save, remove, pullCloud, syncPending
};
