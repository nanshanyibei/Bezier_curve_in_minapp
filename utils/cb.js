/**
 * CloudBase 通用版接入层（@cloudbase/js-sdk，内置 wx_mp 适配器）
 * - 匿名登录（persistence local）
 * - marks 云端同步：以 userKey（设备维度）隔离数据，doc _id = userKey_adcode 可整体 set 覆盖
 * - attractions 查询：云端优先，storage 缓存 7 天
 * - 降级策略：SDK 未安装（未构建 npm）/ 未登录 / 网络失败时返回 null，业务层走本地
 */
const config = require('../config');

const USER_KEY_STORAGE = 'travel.userKey';
const MARKS_LIMIT = 100; // 单次 get 上限，个人标记量足够

let _app = null;
let _readyPromise = null; // null = 不可用 / 未初始化

/** SDK 是否可加载（依赖开发者工具「构建 npm」产物 miniprogram_npm/） */
function sdkAvailable() {
  try {
    require('@cloudbase/js-sdk');
    return true;
  } catch (e) {
    return false;
  }
}

function envConfigured() {
  return config.CLOUDBASE_ENV && config.CLOUDBASE_ENV !== 'YOUR_ENV_ID';
}

/** 初始化 + 匿名登录；永远返回 Promise<app|null>（不可用/失败时 resolve null） */
function ready() {
  if (!sdkAvailable() || !envConfigured()) return Promise.resolve(null);
  if (_readyPromise) return _readyPromise;
  try {
    const cloudbase = require('@cloudbase/js-sdk');
    _app = cloudbase.init({ env: config.CLOUDBASE_ENV });
    const auth = _app.auth({ persistence: 'local' });
    _readyPromise = auth.signInAnonymously()
      .then(() => _app)
      .catch((err) => {
        console.error('[cb] 匿名登录失败，云端降级:', err && err.message || err);
        _readyPromise = null;
        return null;
      });
    return _readyPromise;
  } catch (e) {
    console.error('[cb] 初始化失败:', e.message);
    return Promise.resolve(null);
  }
}

function db() {
  return _app.database();
}

// ---------- userKey（设备维度身份，匿名登录不提供跨设备身份） ----------

function getUserKey() {
  let k = wx.getStorageSync(USER_KEY_STORAGE);
  if (!k) {
    k = 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    wx.setStorageSync(USER_KEY_STORAGE, k);
  }
  return k;
}

// ---------- marks 云端同步 ----------

/** 拉取云端标记列表：[{ adcode, status, name, center, updatedAt }]；失败返回 null */
function fetchMarks() {
  return ready().then((app) => {
    if (!app) return null;
    return db().collection('marks')
      .where({ userKey: getUserKey() })
      .limit(MARKS_LIMIT)
      .get()
      .then((res) => (res.data || []))
      .catch((err) => {
        console.error('[cb] 拉取标记失败:', err && err.message || err);
        return null;
      });
  });
}

/**
 * 写/删一条云端标记（整体覆盖式 set，幂等）
 * doc: { adcode, status(''|删除), name, center, updatedAt }
 * status 为空串时删除云端文档；返回是否成功
 */
function pushMark(doc) {
  return ready().then((app) => {
    if (!app) return false;
    const id = getUserKey() + '_' + doc.adcode;
    const col = db().collection('marks');
    const p = doc.status
      ? col.doc(id).set({ data: Object.assign({ userKey: getUserKey() }, doc) })
      : col.doc(id).remove();
    return p.then(() => true).catch((err) => {
      console.error('[cb] 推送标记失败:', doc.adcode, err && err.message || err);
      return false;
    });
  });
}

// ---------- attractions 景点 ----------

function cacheKey(adcode) {
  return 'travel.attr.' + adcode;
}

function readCache(adcode) {
  try {
    const c = wx.getStorageSync(cacheKey(adcode));
    if (c && c.list && Date.now() - c.ts < config.ATTRACTION_CACHE_TTL) return c.list;
  } catch (e) { /* 缓存坏了当没有 */ }
  return null;
}

function writeCache(adcode, list) {
  try { wx.setStorageSync(cacheKey(adcode), { ts: Date.now(), list: list }); } catch (e) { /* 空间满则放弃缓存 */ }
}

/**
 * 查景点：本地缓存 → 云端（adcode 命中，未命中再查 fallbackCode 省级）
 * 返回 Promise<[{ name, desc, img, bestMonths, tags }]>；云端不可用时返回 []
 */
function fetchAttractions(adcode, fallbackCode, limit) {
  limit = limit || 6;
  const hit = readCache(adcode);
  if (hit) return Promise.resolve(hit);

  return ready().then((app) => {
    if (!app) return Promise.resolve([]);
    const _ = db().command;
    const col = db().collection('attractions');
    const where = fallbackCode && fallbackCode !== adcode
      ? { adcode: _.in([adcode, fallbackCode]) }
      : { adcode: adcode };
    return col.where(where).limit(limit).get().then((res) => {
      const list = (res.data || []).map((d) => ({
        name: d.name || '',
        desc: d.desc || '',
        img: d.img || '',
        bestMonths: d.bestMonths || '',
        tags: d.tags || []
      })).filter((d) => d.name);
      if (list.length) writeCache(adcode, list);
      return list;
    }).catch((err) => {
      console.error('[cb] 查询景点失败:', adcode, err && err.message || err);
      return [];
    });
  });
}

/** 调云函数按需生成景点（LLM 在服务端，key 不落客户端）；返回 Promise<list>，失败 [] */
function genAttractions(adcode, regionName, parentName) {
  return ready().then((app) => {
    if (!app) return Promise.resolve([]);
    return app.callFunction({
      name: 'genAttraction',
      data: { adcode: adcode, name: regionName, parent: parentName || '' }
    }).then((res) => {
      const r = res.result;
      if (r && r.code === 0 && Array.isArray(r.list) && r.list.length) {
        writeCache(adcode, r.list);
        return r.list;
      }
      return [];
    }).catch((err) => {
      console.error('[cb] 云函数调用失败:', err && err.message || err);
      return [];
    });
  });
}

module.exports = {
  ready,
  sdkAvailable,
  envConfigured,
  getUserKey,
  fetchMarks,
  pushMark,
  fetchAttractions,
  genAttractions
};
