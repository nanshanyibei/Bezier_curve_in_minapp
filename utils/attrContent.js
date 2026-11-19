/**
 * 5A 景区内容加载器（2026-11）
 *
 * 分层：包内只留骨架（assets/data/attractions-5a.js，29KB：名称/省市/坐标/年份），
 *       详情内容全部放云端集合 attraction_details，按省级 adcode 一省一文档。
 *
 * 读取顺序：内存 → 本地文件（USER_DATA_PATH/attr/p_xxxxxx.json）→ 云数据库。
 *   - 本地缓存 TTL 30 天，过期先返回旧内容再后台刷新（不阻塞界面）；
 *   - 单省文档 10~40KB，本地最多留 8 个省（LRU，索引存 storage）；
 *   - 写缓存前先校验结构，坏响应不落盘（避免错误页污染缓存）。
 *
 * 缺内容不是错误：load 返回 null，页面按骨架渲染并显示「暂无详细介绍」。
 */
const config = require('../config');

const COL = 'attraction_details';
const DIR = wx.env.USER_DATA_PATH + '/attr';
const INDEX_KEY = 'travel.attrIndex';
const TTL = 30 * 24 * 3600 * 1000;   // 本地缓存有效期
const REFRESH_GAP = 6 * 3600 * 1000; // 主动刷新最小间隔
const MAX_PROV = 8;                  // 本地保留省份数

const fs = wx.getFileSystemManager();
const mem = {};      // key -> { list, map, v, publishedAt, ts, src }
const pending = {};  // key -> Promise（防并发重复请求）

/** 省级 adcode 归一到 p_xxxxxx（659000 兵团并入新疆，与 attractionLayer 一致） */
function provKey(prov) {
  const s = String(prov || '');
  if (!/^\d{6}$/.test(s)) return '';
  return 'p_' + s.slice(0, 2) + '0000';
}

function envReady() {
  return !!(config.WX_CLOUD_ENV && config.WX_CLOUD_ENV !== 'YOUR_ENV_ID');
}

function ensureDir() {
  try {
    fs.accessSync(DIR);
  } catch (e) {
    try { fs.mkdirSync(DIR, true); } catch (e2) { /* 写文件时会再报错，交给调用方降级 */ }
  }
}

function filePath(key) {
  return DIR + '/' + key + '.json';
}

function readIndex() {
  const v = wx.getStorageSync(INDEX_KEY);
  return v && typeof v === 'object' ? v : {};
}

function writeIndex(idx) {
  try { wx.setStorageSync(INDEX_KEY, idx); } catch (e) { /* 索引丢了只是少一层缓存 */ }
}

/** 更新 LRU 索引，超出上限删最旧的文件 */
function touch(key) {
  const idx = readIndex();
  idx[key] = Date.now();
  const keys = Object.keys(idx).sort((a, b) => idx[a] - idx[b]);
  while (keys.length > MAX_PROV) {
    const old = keys.shift();
    try { fs.unlinkSync(filePath(old)); } catch (e) { /* 文件不在就算了 */ }
    delete idx[old];
  }
  writeIndex(idx);
}

function readLocal(key) {
  return new Promise((resolve) => {
    try {
      ensureDir();
      fs.readFile({
        filePath: filePath(key),
        encoding: 'utf8',
        success: (r) => {
          let doc = null;
          try { doc = JSON.parse(r.data); } catch (e) { doc = null; }
          resolve(doc && Array.isArray(doc.spots) ? doc : null);
        },
        fail: () => resolve(null)
      });
    } catch (e) {
      resolve(null);
    }
  });
}

function writeLocal(key, doc) {
  try {
    ensureDir();
    const text = JSON.stringify(doc);
    fs.writeFile({ filePath: filePath(key), data: text, encoding: 'utf8', success: () => touch(key), fail: () => {} });
  } catch (e) { /* 写不进就只留内存缓存 */ }
}

function index(raw) {
  const list = (raw && raw.spots) || [];
  const map = {};
  list.forEach((s) => { if (s && s.name) map[s.name] = s; });
  return {
    list: list,
    map: map,
    v: (raw && raw.v) || 0,
    publishedAt: (raw && raw.publishedAt) || 0,
    ts: (raw && raw.ts) || 0,
    src: (raw && raw.src) || 'unknown'
  };
}

/** 读云端单省文档；集合不存在 / 无权限 / 无该省内容一律按 null 处理 */
function fetchCloud(key) {
  if (!envReady()) return Promise.resolve(null);
  let db;
  try {
    db = wx.cloud.database();
  } catch (e) {
    return Promise.resolve(null);
  }
  return db.collection(COL).doc(key).get()
    .then((r) => {
      const d = r && r.data;
      return d && Array.isArray(d.spots) ? d : null;
    })
    .catch(() => null);
}

/**
 * 快速读取：内存 → 本地（未过期）→ 云端。
 * 本地没有或已过期时走网络；网络失败返回 null（页面降级骨架）。
 */
function load(prov) {
  const key = provKey(prov);
  if (!key) return Promise.resolve(null);
  if (mem[key] && Date.now() - mem[key].ts < TTL) return Promise.resolve(mem[key]);
  if (pending[key]) return pending[key];

  const p = readLocal(key).then((local) => {
    if (local && Date.now() - (local.ts || 0) < TTL) {
      mem[key] = index(Object.assign({ src: 'local' }, local));
      return mem[key];
    }
    // 本地过期/为空 → 拉云端；拉不到时若有旧内容仍然给出去
    return fetchCloud(key).then((doc) => {
      if (!doc) {
        if (local) {
          mem[key] = index(Object.assign({ src: 'local' }, local));
          return mem[key];
        }
        return null;
      }
      const wrapped = Object.assign({}, doc, { ts: Date.now(), src: 'cloud' });
      writeLocal(key, wrapped);
      mem[key] = index(wrapped);
      return mem[key];
    });
  }).then((r) => {
    delete pending[key];
    return r;
  }).catch(() => {
    delete pending[key];
    return null;
  });

  pending[key] = p;
  return p;
}

/**
 * 主动刷新：间隔小于 REFRESH_GAP 直接返回缓存，避免每次点开弹层都发请求。
 * force = true 时忽略间隔（详情页下拉刷新用）。
 */
function refresh(prov, force) {
  const key = provKey(prov);
  if (!key) return Promise.resolve(null);
  const hit = mem[key];
  if (!force && hit && hit.src === 'cloud' && Date.now() - hit.ts < REFRESH_GAP) {
    return Promise.resolve(hit);
  }
  return fetchCloud(key).then((doc) => {
    if (!doc) return hit || null;
    const wrapped = Object.assign({}, doc, { ts: Date.now(), src: 'cloud' });
    writeLocal(key, wrapped);
    mem[key] = index(wrapped);
    return mem[key];
  });
}

/** 取单省全部内容：{ list, map, v, publishedAt, ts, src } | null */
function provinces(prov) {
  return load(prov);
}

/** 取单个景区详情；没有内容返回 null */
function spotOf(prov, name) {
  return load(prov).then((d) => (d && d.map[name]) || null);
}

/** 同步取（仅内存命中）：名录列表补 oneline 用，绝不触发网络 */
function cachedSpot(prov, name) {
  const key = provKey(prov);
  const d = key && mem[key];
  return (d && d.map[name]) || null;
}

/** 该省内容是否已在内存（列表要判断能否立刻补 oneline） */
function hasCache(prov) {
  const key = provKey(prov);
  return !!(key && mem[key]);
}

/** 清掉某省缓存（内容异常时的兜底出口） */
function clear(prov) {
  const key = provKey(prov);
  if (!key) return;
  delete mem[key];
  try { fs.unlinkSync(filePath(key)); } catch (e) { /* ignore */ }
  const idx = readIndex();
  delete idx[key];
  writeIndex(idx);
}

module.exports = {
  COL,
  provKey,
  load,
  refresh,
  provinces,
  spotOf,
  cachedSpot,
  hasCache,
  clear
};
