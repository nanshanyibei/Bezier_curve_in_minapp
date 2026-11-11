/**
 * CloudBase 接入层（HTTP 网关云函数 + @cloudbase/js-sdk 只读景点）
 *
 * 为什么不直连数据库 / 不用 callFunction：
 *   1. 本环境未真正开通「微信小程序登录」provider 通道（provider/token 恒返回 404），
 *      auth.signInWithOpenId() 不可用；
 *   2. createTicket 必须有私钥文件，云函数环境身份不够（Cannot destructure 'env_id'），
 *      而管理端生成的私钥不向调用方返回明文；
 *   3. SDK 的 callFunction 走 /v1/functions/...，匿名身份被拒
 *      （EXCEED_AUTHORITY: Request exceeds granted authority），客户端拿不到结果。
 *   → 私有数据（marks / diaries / chats）一律走 HTTP 网关上的 wxauth（公网路由，自带 HMAC 鉴权）；
 *     attractions 是公开只读集合，用 js-sdk 匿名态直连（ADMINWRITE 允许读）。
 *
 * 身份：openid（云函数用 AppSecret 换，稳定）。删小程序/换手机后 wx.login 静默重登，openid 不变 → 数据自动认回。
 * 安全：openid 只在服务端出现，客户端只持有 HMAC 签名 token（30 天）；每条文档 owner 由服务端强制写入。
 *
 * 降级：网关未配置 / 登录失败 → 业务层走本地 storage。
 */
const config = require('../config');

const USER_KEY_STORAGE = 'travel.userKey'; // v1 设备维度身份，仅迁移/兜底
const OPENID_STORAGE = 'cb.openid';
const TOKEN_STORAGE = 'cb.token';
const MARKS_LIMIT = 100;
const GATEWAY_BASE = config.CLOUD_GATEWAY_BASE || '';
const GW = { gateway: true }; // SDK 不可用但网关可用时 ready() 的占位返回值（truthy）

let _app = null;
let _auth = null;
let _readyPromise = null;
let _identityKey = '';
let _openid = '';
let _token = '';
let _loginInfo = { logged: false, mode: 'none', uid: '', raw: null };

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

/** 身份指纹：只留字母数字，限长 */
function toKey(raw) {
  const s = String(raw || '').replace(/[^A-Za-z0-9]/g, '');
  return s ? s.slice(0, 32) : '';
}

function wxLoginCode() {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (r) => (r && r.code ? resolve(r.code) : reject(new Error('wx.login 未返回 code'))),
      fail: (e) => reject(new Error((e && e.errMsg) || 'wx.login 失败'))
    });
  });
}

/** 网关是否可用（与 cloudbase SDK 解耦，SDK 挂了也能同步数据） */
function gwReady() {
  return !!GATEWAY_BASE;
}

/**
 * 调 HTTP 网关上的云函数：POST {fnName}，body 即 event
 * 返回 Promise<result 对象|null>；网络失败 resolve null（业务层降级）
 */
function gwRequest(fnName, payload) {
  if (!GATEWAY_BASE) return Promise.resolve(null);
  return new Promise((resolve) => {
    wx.request({
      url: GATEWAY_BASE + '/' + fnName,
      method: 'POST',
      header: { 'content-type': 'application/json' },
      data: payload || {},
      timeout: 15000,
      success: (res) => {
        let body = res && res.data;
        if (typeof body === 'string') {
          try { body = JSON.parse(body); } catch (e) { body = null; }
        }
        if (!body || typeof body !== 'object') {
          console.error('[cb] 网关响应异常:', fnName, res && res.statusCode, String(res && res.data).slice(0, 120));
          return resolve(null);
        }
        resolve(body);
      },
      fail: (err) => {
        console.error('[cb] 网关调用失败:', fnName, (err && err.errMsg) || err);
        resolve(null);
      }
    });
  });
}

/** 调 wxauth 网关 */
function callApi(action, payload) {
  const data = Object.assign({ action: action, token: _token }, payload || {});
  return gwRequest('wxauth', data);
}

/** wx.login → 云函数换 openid / token */
function loginByWx() {
  return wxLoginCode()
    .then((code) => callApi('login', { code: code, token: '' }))
    .then((r) => {
      if (!r || r.code !== 0 || !r.openid || !r.token) {
        throw new Error('网关登录失败: ' + ((r && r.msg) || 'empty'));
      }
      _openid = r.openid;
      _token = r.token;
      _identityKey = toKey(r.openid);
      try {
        wx.setStorageSync(OPENID_STORAGE, r.openid);
        wx.setStorageSync(TOKEN_STORAGE, r.token);
      } catch (e) { /* 空间满忽略 */ }
      _loginInfo = { logged: true, mode: 'cloud_gateway', uid: r.openid, raw: '' };
      return r;
    });
}

/** 尽力初始化 SDK：只服务 attractions 直连读，失败不影响网关同步 */
function initSdk() {
  if (!sdkAvailable() || !envConfigured()) return Promise.resolve(null);
  try {
    const cloudbase = require('@cloudbase/js-sdk');
    _app = cloudbase.init({ env: config.CLOUDBASE_ENV });
    _auth = _app.auth({ persistence: 'local' });
    return Promise.resolve(_auth.signInAnonymously())
      .catch((err) => {
        console.warn('[cb] 匿名登录失败，景点读改走本地缓存:', (err && err.message) || err);
        return null;
      })
      .then(() => _app);
  } catch (e) {
    console.error('[cb] SDK 初始化失败:', e.message);
    return Promise.resolve(null);
  }
}

function ready() {
  if (_readyPromise) return _readyPromise;
  if (!gwReady() && !sdkAvailable()) return Promise.resolve(null);

  _readyPromise = initSdk()
    .then(() => {
      // 本地已有 token：先用，401 时再由 callApiRetry 重登
      let cachedToken = '';
      try { cachedToken = wx.getStorageSync(TOKEN_STORAGE) || ''; } catch (e) { /* ignore */ }
      if (cachedToken) {
        _token = cachedToken;
        _openid = (function () { try { return wx.getStorageSync(OPENID_STORAGE) || ''; } catch (e) { return ''; } })();
        _identityKey = toKey(_openid);
        if (_identityKey) {
          _loginInfo = { logged: true, mode: 'resume', uid: _openid, raw: '' };
          return null;
        }
      }
      return loginByWx();
    })
    .then(() => _app || GW)
    .catch((err) => {
      const msg = (err && (err.message || err.errMsg)) || err;
      console.error('[cb] 登录失败，降级本地模式:', msg);
      _loginInfo = { logged: false, mode: 'local', uid: _openid, raw: String(msg) };
      if (!_identityKey) _identityKey = toKey(getLegacyUserKey());
      return _app || GW;
    })
    .then((v) => {
      console.log('[cb] 就绪:', _loginInfo);
      return v;
    });

  return _readyPromise;
}

function db() {
  return _app.database();
}

/** token 失效时重登一次并重试 */
function callApiRetry(action, payload) {
  return callApi(action, payload).then((r) => {
    if (r && r.code === 401) {
      _token = '';
      try { wx.removeStorageSync(TOKEN_STORAGE); } catch (e) { /* ignore */ }
      return loginByWx().then(() => callApi(action, payload)).catch(() => r);
    }
    return r;
  });
}

function getLoginInfo() {
  return Object.assign({}, _loginInfo);
}

function getOpenid() {
  return _openid || '';
}

function getLegacyUserKey() {
  let k = wx.getStorageSync(USER_KEY_STORAGE);
  if (!k) {
    k = 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    wx.setStorageSync(USER_KEY_STORAGE, k);
  }
  return k;
}

/** 当前身份键：登录后为 openid 指纹，未登录为设备键 */
function getUserKey() {
  if (_identityKey) return _identityKey;
  return getLegacyUserKey();
}

// ---------- marks ----------

/** 拉云端标记：[{ adcode, status, name, center, updatedAt }]；失败 null */
function fetchMarks() {
  return ready().then((app) => {
    if (!app) return null;
    return callApiRetry('pull', { col: 'marks' }).then((r) => {
      if (!r || r.code !== 0) return null;
      return (r.list || []).slice(0, MARKS_LIMIT);
    });
  });
}

/** 写/删一条标记（status 空 = 删除） */
function pushMark(doc) {
  return ready().then((app) => {
    if (!app) return false;
    const p = doc.status
      ? callApiRetry('put', {
        col: 'marks',
        id: doc.adcode,
        data: {
          adcode: doc.adcode,
          status: doc.status,
          name: doc.name || '',
          center: doc.center || null,
          updatedAt: doc.updatedAt || Date.now()
        }
      })
      : callApiRetry('del', { col: 'marks', id: doc.adcode });
    return p.then((r) => !!(r && r.code === 0));
  });
}

// ---------- 通用集合（diaries / chats） ----------

/** 拉当前用户在某集合的全部文档 */
function listDocs(collectionName) {
  return ready().then((app) => {
    if (!app) return null;
    return callApiRetry('pull', { col: collectionName }).then((r) => {
      if (!r || r.code !== 0) return null;
      return r.list || [];
    });
  });
}

/** 覆盖写一条；id 由业务决定（标记用 adcode、日记用日期） */
function setDoc(collectionName, id, data) {
  return ready().then((app) => {
    if (!app) return false;
    return callApiRetry('put', { col: collectionName, id: id, data: data })
      .then((r) => !!(r && r.code === 0));
  });
}

function removeDoc(collectionName, id) {
  return ready().then((app) => {
    if (!app) return false;
    return callApiRetry('del', { col: collectionName, id: id })
      .then((r) => !!(r && r.code === 0));
  });
}

/** 清空当前用户在某个集合的全部文档；返回删除条数（-1 表示失败） */
function clearCollection(collectionName) {
  return ready().then((app) => {
    if (!app) return -1;
    return callApiRetry('clear', { col: collectionName })
      .then((r) => (r && r.code === 0 ? (r.n || 0) : -1));
  });
}

// ---------- attractions（公开只读，直连更快） ----------

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
  try { wx.setStorageSync(cacheKey(adcode), { ts: Date.now(), list: list }); } catch (e) { /* 空间满则放弃 */ }
}

/**
 * 查景点：本地缓存 → 云端 attractions（adcode 命中，未命中再查 fallbackCode 省级）
 * 该集合权限档为 ADMINWRITE（所有用户可读、客户端不可写），匿名登录态即可读。
 */
function fetchAttractions(adcode, fallbackCode, limit) {
  limit = limit || 6;
  const hit = readCache(adcode);
  if (hit) return Promise.resolve(hit);

  return ready().then((app) => {
    if (!_app) return Promise.resolve([]); // SDK 不可用时只能吃缓存
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

/** 调云函数按需生成景点（LLM 在服务端，key 不落客户端）
 *  走网关而非 SDK callFunction：匿名身份调 /v1/functions 会被 EXCEED_AUTHORITY 拒。
 *  需先给 genAttraction 建同域路由（如 /genAttraction）才生效。 */
function genAttractions(adcode, regionName, parentName) {
  return ready().then((app) => {
    if (!gwReady()) return Promise.resolve([]);
    return gwRequest('genAttraction', {
      adcode: adcode, name: regionName, parent: parentName || ''
    }).then((r) => {
      if (r && r.code === 0 && Array.isArray(r.list) && r.list.length) {
        writeCache(adcode, r.list);
        return r.list;
      }
      return [];
    });
  });
}

module.exports = {
  ready,
  sdkAvailable,
  envConfigured,
  getUserKey,
  getLoginInfo,
  getOpenid,
  fetchMarks,
  pushMark,
  fetchAttractions,
  genAttractions,
  listDocs,
  setDoc,
  removeDoc,
  clearCollection
};
