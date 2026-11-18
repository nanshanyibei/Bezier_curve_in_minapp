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
// 与服务端 wxauth 的上限保持一致：base64 超过 2MB 由网关/云函数直接拒绝
const UPLOAD_MAX_BASE64 = 2 * 1024 * 1024;
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
function gwRequest(fnName, payload, timeoutMs) {
  if (!GATEWAY_BASE) return Promise.resolve(null);
  return new Promise((resolve) => {
    wx.request({
      url: GATEWAY_BASE + '/' + fnName,
      method: 'POST',
      header: { 'content-type': 'application/json' },
      data: payload || {},
      timeout: timeoutMs || 15000,
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
function callApi(action, payload, timeoutMs) {
  const data = Object.assign({ action: action, token: _token }, payload || {});
  return gwRequest('wxauth', data, timeoutMs);
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
function callApiRetry(action, payload, timeoutMs) {
  return callApi(action, payload, timeoutMs).then((r) => {
    if (r && r.code === 401) {
      _token = '';
      try { wx.removeStorageSync(TOKEN_STORAGE); } catch (e) { /* ignore */ }
      return loginByWx().then(() => callApi(action, payload, timeoutMs)).catch(() => r);
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

// ---------- 云存储（回忆照片） ----------

/** 从本地路径猜扩展名，默认 jpg */
function guessExt(localPath) {
  const m = /\.([A-Za-z0-9]+)(?:\?|$)/.exec(String(localPath || ''));
  const e = m ? m[1].toLowerCase() : 'jpg';
  return /^(jpg|jpeg|png|webp)$/.test(e) ? e : 'jpg';
}

/** 读本地文件为 base64（不含 data: 前缀） */
function readFileBase64(localPath) {
  return new Promise((resolve) => {
    try {
      wx.getFileSystemManager().readFile({
        filePath: localPath,
        encoding: 'base64',
        success: (res) => resolve(res && res.data ? res.data : ''),
        fail: (err) => {
          console.error('[cb] 读本地图片失败:', (err && err.errMsg) || err);
          resolve('');
        }
      });
    } catch (e) {
      resolve('');
    }
  });
}

/**
 * 上传一张本地图片到云存储 → { fileID }
 * 失败（未登录 / 无网关 / 过大 / 网络错）一律 resolve null，由业务层降级用本地路径展示。
 * 图片先由调用方压缩到长边 1600 左右再传，避免撞网关体积上限。
 */
function uploadImage(localPath, ext) {
  if (!localPath || !gwReady()) return Promise.resolve(null);
  return ready().then((app) => {
    if (!app) return null;
    return readFileBase64(localPath).then((base64) => {
      if (!base64) return null;
      if (base64.length > UPLOAD_MAX_BASE64) {
        console.warn('[cb] 图片超过体积上限，跳过上传:', localPath, base64.length);
        return null;
      }
      return callApiRetry('upload', { base64: base64, ext: ext || guessExt(localPath) }, 30000)
        .then((r) => (r && r.code === 0 && r.fileID ? { fileID: r.fileID } : null));
    });
  }).catch((err) => {
    console.error('[cb] 上传失败:', (err && err.message) || err);
    return null;
  });
}

/** 批量 fileID → 临时链接（默认 2 小时），返回 { fileID: url } */
function getFileUrls(fileIDs) {
  const ids = (fileIDs || []).filter(Boolean);
  if (!ids.length || !gwReady()) return Promise.resolve({});
  return ready().then((app) => {
    if (!app) return {};
    return callApiRetry('fileUrl', { fileIDs: ids }).then((r) => {
      if (!r || r.code !== 0) return {};
      const map = {};
      (r.list || []).forEach((it) => {
        if (it && it.fileID && it.tempFileURL) map[it.fileID] = it.tempFileURL;
      });
      return map;
    });
  }).catch(() => ({}));
}

/** 删除云存储文件（条目删除时清理，失败静默容忍孤儿） */
function deleteFiles(fileIDs) {
  const ids = (fileIDs || []).filter(Boolean);
  if (!ids.length || !gwReady()) return Promise.resolve(false);
  return ready().then((app) => {
    if (!app) return false;
    return callApiRetry('delFiles', { fileIDs: ids }).then((r) => !!(r && r.code === 0));
  }).catch(() => false);
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

/* @dev:begin */
/**
 * 网关 POST（严格版）：失败直接 reject 并带可读原因。
 * 与 gwRequest 的区别：gwRequest 网络失败时 resolve(null) 让业务静默降级，
 * 这里必须把原因抛到调用方，UI 才能告诉用户到底哪一步断了。
 */
function gwPostStrict(fnName, payload, timeoutMs) {
  if (!GATEWAY_BASE) return Promise.reject(new Error('未配置云端网关'));
  return new Promise((resolve, reject) => {
    wx.request({
      url: GATEWAY_BASE + '/' + fnName,
      method: 'POST',
      header: { 'content-type': 'application/json' },
      data: payload || {},
      timeout: timeoutMs || config.GEN_TIMEOUT,
      success: (res) => {
        let body = res && res.data;
        if (typeof body === 'string') {
          try { body = JSON.parse(body); } catch (e) { body = null; }
        }
        if (!body || typeof body !== 'object') {
          reject(new Error('网关返回异常（HTTP ' + (res && res.statusCode) + '）'));
          return;
        }
        resolve(body);
      },
      fail: (err) => reject(new Error(gwErrText(err)))
    });
  });
}

/** wx.request 的 fail 归类成人能看懂的原因 */
function gwErrText(err) {
  const m = String((err && err.errMsg) || '');
  if (/url not in domain list/i.test(m)) {
    return '网关域名未加入 request 合法域名（开发版可临时开调试模式）';
  }
  if (/timeout/i.test(m)) return '请求超时，稍后再试';
  if (/net::|ERR_CONNECTION|ERR_NAME/i.test(m)) return '网络连接失败，检查手机网络';
  if (/ssl|handshake/i.test(m)) return 'HTTPS 证书校验失败';
  return m || '网络请求失败';
}

/** 一次网关调用（payload 里带当前 token） */
function genRequest(adcode, regionName, parentName) {
  return gwPostStrict('genAttraction', {
    adcode: adcode,
    name: regionName,
    parent: parentName || '',
    token: _token
  });
}

/**
 * 按需生成景点推荐：唯一链路是云函数 genAttraction。
 * LLM 的 key 只存在云函数环境变量里，客户端不持有、不透传。
 * 走网关而非 SDK callFunction：匿名身份调 /v1/functions 会被 EXCEED_AUTHORITY 拒。
 * 注意：超时按 config.GEN_TIMEOUT（55s）算，模型生成本身就要 15~30s，
 * 沿用 gwRequest 的 15s 默认值会稳定超时。
 */
function genAttractions(adcode, regionName, parentName) {
  return ready().then(() => {
    if (!gwReady()) return Promise.reject(new Error('未配置云端网关'));
    return genRequest(adcode, regionName, parentName)
      .then((r) => {
        // token 30 天过期：清掉重登一次再试
        if (r && r.code === 401) {
          _token = '';
          try { wx.removeStorageSync(TOKEN_STORAGE); } catch (e) { /* ignore */ }
          return loginByWx().then(() => genRequest(adcode, regionName, parentName));
        }
        return r;
      })
      .then((r) => {
        if (r && r.code === 0 && Array.isArray(r.list) && r.list.length) {
          writeCache(adcode, r.list);
          return r.list;
        }
        if (r && r.code === 2) throw new Error('服务端未配置 SILICONFLOW_KEY');
        if (r && r.code === 401) throw new Error('登录态失效，请重进小程序再试');
        throw new Error((r && r.msg) || '生成失败');
      });
  }).catch((err) => {
    // 重登失败时的原始文案太绕，换成能指导操作的
    const m = (err && err.message) || '';
    if (/网关登录失败|wx\.login/.test(m)) {
      throw new Error('网关登录失败，检查云函数 WX_APPID/WX_SECRET 与网关域名');
    }
    throw err;
  });
}
/* @dev:end */

module.exports = {
  ready,
  sdkAvailable,
  envConfigured,
  cloudReady: gwReady,
  getUserKey,
  getLoginInfo,
  getOpenid,
  fetchMarks,
  pushMark,
  fetchAttractions,
  /* @dev:begin */
  genAttractions,
  /* @dev:end */
  listDocs,
  setDoc,
  removeDoc,
  clearCollection,
  uploadImage,
  getFileUrls,
  deleteFiles
};
