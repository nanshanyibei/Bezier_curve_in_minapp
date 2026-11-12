/**
 * 城市回忆存储（key: travel.memories）
 * 结构 v1：{ v: 1, items: [entry] }
 * entry = {
 *   id:        'adcode_createdAt_rand'   // 一城多条，不能拿 adcode 当 id
 *   adcode:    '330100'                  // 关联 travelStore 的 marks key
 *   cityName:  '杭州'                     // 冗余存名字，离线列表可用
 *   date:      '2026-11-12'              // 旅行日期（不是同步时间）
 *   title:     ''                        // 可选，≤40 字
 *   text:      ''                        // 0–5000 字
 *   photos:    [{ fileID, local, w, h, failed }]
 *   createdAt / updatedAt: number        // 冲突按 updatedAt 新者胜
 *   synced:    boolean                   // 云端推成功与否（仅本地用，不上云）
 * }
 *
 * 设计要点：
 * - 回忆是「事件」不是「状态」，所以 adcode 不能当 _id；去三次杭州要能分开记。
 * - 图片先 saveFile 落到本地永久路径再异步上传，上传失败的仍能显示（降级不阻断）。
 * - 本地优先：所有操作即时落 storage，离线完全可用；pullCloud 按 updatedAt 新者胜合并。
 */
const cb = require('./cb');

const KEY = 'travel.memories';
const TEXT_MAX = 5000;
const TITLE_MAX = 40;
const PHOTOS_MAX = 9;

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
    console.error('[memory] 本地存储写入失败:', (e && e.message) || e);
  }
}

function today() {
  const d = new Date();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
}

function rand(n) {
  return Math.random().toString(36).slice(2, 2 + (n || 5));
}

/** 生成 id：同城同秒创建两条也不会撞 */
function makeId(adcode, createdAt) {
  return String(adcode) + '_' + createdAt + '_' + rand(5);
}

function normalizePhotos(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(function (p) {
    return p && (p.fileID || p.local);
  }).slice(0, PHOTOS_MAX).map(function (p) {
    return {
      fileID: p.fileID || '',
      local: p.local || '',
      w: p.w || 0,
      h: p.h || 0,
      failed: !!p.failed
    };
  });
}

/**
 * 清洗一条 entry（本地 / 云端进来都要过这一道）
 * 文字与图片至少有一项，否则视为空条目
 */
function normalize(raw) {
  if (!raw || !raw.id || !raw.adcode) return null;
  const text = String(raw.text || '').slice(0, TEXT_MAX);
  const photos = normalizePhotos(raw.photos);
  if (!text.trim() && !photos.length) return null;
  return {
    id: String(raw.id),
    adcode: String(raw.adcode),
    cityName: String(raw.cityName || ''),
    date: String(raw.date || today()).slice(0, 10),
    title: String(raw.title || '').slice(0, TITLE_MAX),
    text: text,
    photos: photos,
    createdAt: raw.createdAt || 0,
    updatedAt: raw.updatedAt || 0,
    // 默认未同步，推送成功后才置 true；否则关页面太快会导致 syncPending 漏推
    synced: raw.synced === true
  };
}

/** 某城的全部回忆，按旅行日期倒序（同日按创建时间倒序） */
function listByCity(adcode) {
  const code = String(adcode);
  return loadAll().items.filter(function (e) { return e.adcode === code; })
    .sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
}

function listAll() {
  return loadAll().items.slice().sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
}

function get(id) {
  const key = String(id);
  const hit = loadAll().items.find(function (e) { return e.id === key; });
  return hit || null;
}

/** 新建/更新；返回落盘后的 entry（null 表示内容为空，等同删除） */
function save(entry) {
  const d = loadAll();
  const now = Date.now();
  const input = Object.assign({}, entry);
  if (!input.id) {
    input.createdAt = now;
    input.id = makeId(input.adcode, now);
  }
  input.updatedAt = now;
  const clean = normalize(input);
  if (!clean) {
    if (input.id) remove(input.id);
    return null;
  }
  const idx = d.items.findIndex(function (e) { return e.id === clean.id; });
  if (idx >= 0) {
    clean.createdAt = d.items[idx].createdAt || clean.createdAt || now;
    d.items[idx] = clean;
  } else {
    d.items.push(clean);
  }
  saveAll(d);
  pushOne(clean);
  return clean;
}

/** 只改字段、不重置 updatedAt 以外的内容（内部用） */
function patchLocal(id, fields) {
  const d = loadAll();
  const idx = d.items.findIndex(function (e) { return e.id === String(id); });
  if (idx < 0) return null;
  d.items[idx] = Object.assign({}, d.items[idx], fields);
  saveAll(d);
  return d.items[idx];
}

/** 推一条到云端（失败静默，synced=false 留给下次补推） */
function pushOne(entry) {
  if (!entry) return;
  const payload = {
    id: entry.id,
    adcode: entry.adcode,
    cityName: entry.cityName,
    date: entry.date,
    title: entry.title,
    text: entry.text,
    photos: entry.photos.map(function (p) {
      return { fileID: p.fileID || '', w: p.w || 0, h: p.h || 0 };
    }),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt
  };
  cb.setDoc('memories', entry.id, payload).then(function (ok) {
    patchLocal(entry.id, { synced: !!ok });
  });
}

function remove(id) {
  const key = String(id);
  const d = loadAll();
  const idx = d.items.findIndex(function (e) { return e.id === key; });
  if (idx < 0) return false;
  const gone = d.items[idx];
  d.items.splice(idx, 1);
  saveAll(d);
  cb.removeDoc('memories', key);
  // 云存储里的图片一并清理（失败静默，容忍孤儿文件）
  const fileIds = (gone.photos || []).map(function (p) { return p.fileID; })
    .filter(function (f) { return !!f; });
  if (fileIds.length) cb.deleteFiles(fileIds);
  return true;
}

/** { adcode: { count, photos } }，地图角标与清单页用 */
function countByCity() {
  const out = {};
  loadAll().items.forEach(function (e) {
    if (!out[e.adcode]) out[e.adcode] = { count: 0, photos: 0 };
    out[e.adcode].count++;
    out[e.adcode].photos += (e.photos || []).length;
  });
  return out;
}

function total() {
  const items = loadAll().items;
  let photos = 0;
  items.forEach(function (e) { photos += (e.photos || []).length; });
  return { count: items.length, photos: photos, cities: Object.keys(countByCity()).length };
}

/**
 * 拉云端按 updatedAt 新者胜合并，返回 { items, changed }
 * 云端不可用时 changed=false
 */
function pullCloud() {
  return cb.listDocs('memories').then(function (list) {
    if (!list || !list.length) return { items: loadAll().items, changed: false };
    const d = loadAll();
    const map = {};
    d.items.forEach(function (e) { map[e.id] = e; });
    let changed = false;
    list.forEach(function (raw) {
      const remote = normalize(raw);
      if (!remote) return;
      const cur = map[remote.id];
      if (cur && (cur.updatedAt || 0) >= remote.updatedAt) return;
      // 云端没有本地临时路径，本地有就保留，避免刚存的图变成灰块
      if (cur && cur.photos) {
        remote.photos = remote.photos.map(function (p) {
          if (p.local) return p;
          const hit = cur.photos.find(function (q) { return q.fileID && q.fileID === p.fileID; });
          return hit && hit.local ? Object.assign({}, p, { local: hit.local }) : p;
        });
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
  const d = loadAll();
  const pending = d.items.filter(function (e) { return !e.synced; });
  if (!pending.length) return Promise.resolve(0);
  return Promise.all(pending.map(function (e) {
    return cb.setDoc('memories', e.id, {
      id: e.id, adcode: e.adcode, cityName: e.cityName, date: e.date,
      title: e.title, text: e.text, createdAt: e.createdAt, updatedAt: e.updatedAt,
      photos: e.photos.map(function (p) {
        return { fileID: p.fileID || '', w: p.w || 0, h: p.h || 0 };
      })
    }).then(function (ok) {
      if (ok) patchLocal(e.id, { synced: true });
      return ok ? 1 : 0;
    });
  })).then(function (arr) {
    return arr.reduce(function (a, b) { return a + b; }, 0);
  });
}

module.exports = {
  KEY, TEXT_MAX, TITLE_MAX, PHOTOS_MAX, today,
  listByCity, listAll, get, save, remove,
  countByCity, total, pullCloud, syncPending
};
