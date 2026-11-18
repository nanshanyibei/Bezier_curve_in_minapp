/**
 * 微信云开发接入层（wx.cloud 直连，2026-11 迁移版）
 *
 * 旧架构（腾讯云 CloudBase HTTP 网关 + wxauth HMAC 鉴权）废弃原因见 docs/migrate-to-wxcloud.md。
 * 新架构全部走微信内部通道，免域名免备案：
 *   1. 数据库：wx.cloud.database() 客户端直查，默认权限「仅创建者可读写」自动按 _openid 隔离；
 *   2. 景点：attractions 集合权限设为「所有用户可读」，客户端直查；
 *   3. 云存储：uploadFile / getTempFileURL / deleteFile，不再走 base64 网关；
 *   4. 景点生成：wx.cloud.callFunction('genAttraction')，LLM key 只在云函数环境变量。
 *
 * 身份：_openid 由云开发自动注入，同 appid 下稳定。旧环境 owner 字段由导入脚本映射到新 openid。
 * 兼容：16 个对外方法名与签名保持不变，页面层零改动。
 */
const config = require('../config');

const USER_KEY_STORAGE = 'travel.userKey'; // v1 设备维度身份，仅兜底
const MARKS_LIMIT = 100;
// 客户端单次 get 上限 20 条（云开发客户端侧硬限制），列表拉取分页绕过
const PAGE_SIZE = 20;

let _inited = false;
let _readyPromise = null;
let _loginInfo = { logged: false, mode: 'none', uid: '', raw: null };
let _openid = '';

function envConfigured() {
  return config.WX_CLOUD_ENV && config.WX_CLOUD_ENV !== 'YOUR_ENV_ID';
}

/** 兼容旧导出：SDK 可用性即环境是否配置（wx.cloud 基础库自带，无需 npm 依赖） */
function sdkAvailable() {
  return envConfigured();
}

function initCloud() {
  if (_inited || !envConfigured()) return;
  wx.cloud.init({
    env: config.WX_CLOUD_ENV,
    traceUser: true
  });
  _inited = true;
}

function db() {
  return wx.cloud.database();
}

/** 兼容旧导出 cloudReady()：原语义是网关可用即 true */
function cloudReady() {
  return envConfigured();
}

/**
 * 登录：init + whoami 云函数拿 openid。
 * whoami 未部署 / 调用失败 → 不阻塞：客户端直连数据库的归属由云开发自动注入的
 * _openid 保证（写文档时自动带），登录态按"init 成功即已登录"处理，仅 openid 未知。
 * 数据接口各自失败时再逐个降级本地。
 */
function ready() {
  if (_readyPromise) return _readyPromise;
  if (!envConfigured()) return Promise.resolve(null);

  _readyPromise = new Promise((resolve) => {
    try {
      initCloud();
    } catch (e) {
      resolve(null);
      return;
    }
    wx.cloud.callFunction({ name: 'whoami' })
      .then((r) => {
        const res = r && r.result;
        if (res && res.openid) {
          _openid = res.openid;
          _loginInfo = { logged: true, mode: 'wxcloud', uid: res.openid, raw: '' };
          try { wx.setStorageSync('cb.openid', res.openid); } catch (e) { /* ignore */ }
        } else {
          _loginInfo = { logged: true, mode: 'wxcloud', uid: '', raw: 'whoami 无 openid' };
        }
        resolve(_inited);
      })
      .catch((err) => {
        const msg = (err && (err.errMsg || err.message)) || String(err);
        console.warn('[cb] whoami 不可用（未部署？），按已登录继续，openid 未知:', msg);
        _loginInfo = { logged: true, mode: 'wxcloud', uid: '', raw: msg };
        resolve(_inited); // init 已成功，数据库/云存储照常可用
      });
  }).then((ok) => {
    console.log('[cb] 就绪:', _loginInfo);
    return ok || null;
  });

  return _readyPromise;
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
  if (_openid) return toKey(_openid);
  return getLegacyUserKey();
}

/** 身份指纹：只留字母数字，限长 */
function toKey(raw) {
  const s = String(raw || '').replace(/[^A-Za-z0-9]/g, '');
  return s ? s.slice(0, 32) : '';
}

/** 分页拉全集合（绕过客户端单次 20 条上限），失败 resolve null */
function fetchAll(name, filter) {
  const col = db().collection(name);
  const base = filter ? col.where(filter) : col;
  const out = [];
  function page(skip) {
    return base.skip(skip).limit(PAGE_SIZE).get().then((res) => {
      const batch = res.data || [];
      out.push.apply(out, batch);
      if (batch.length === PAGE_SIZE) return page(skip + PAGE_SIZE);
      return out;
    }).catch((err) => {
      console.error('[cb] 拉取集合失败:', name, (err && err.errMsg) || err);
      return out.length ? out : null;
    });
  }
  return page(0);
}

/**
 * 旧环境迁移过来的文档 _id 是「{旧owner}_{业务键}」，与新版按业务键写入的 _id 不一致，
 * 会导致同一条数据出现两份、删除失效。读到这类文档时按业务键重建一份再删旧文档（幂等）。
 */
const _docIds = {}; // collectionName -> { 业务键: 现有文档 _id }

function rememberIds(collectionName, docs, keyOf) {
  const m = _docIds[collectionName] || (_docIds[collectionName] = {});
  docs.forEach((d) => {
    const k = keyOf(d);
    if (k && !m[String(k)]) m[String(k)] = d._id;
  });
}

/** 写入/删除时用云端现有的 _id（避免归一完成前又写出一份重复文档） */
function resolveId(collectionName, id) {
  const m = _docIds[collectionName];
  return (m && m[String(id)]) || String(id);
}

function normalizeIds(collectionName, docs, keyOf) {
  if (!docs || !docs.length) return;
  rememberIds(collectionName, docs, keyOf);

  const col = db().collection(collectionName);
  const ids = {};
  docs.forEach((d) => { ids[String(d._id)] = true; });

  docs.forEach((d) => {
    const key = keyOf(d);
    if (!key || String(d._id) === String(key)) return;
    const oldId = String(d._id);
    const m = _docIds[collectionName];

    // 规范 id 已存在（通常是新版写入的文档），旧文档直接删掉
    if (ids[String(key)]) {
      col.doc(oldId).remove()
        .then(() => { if (m) m[String(key)] = String(key); })
        .catch((err) => console.error('[cb] 删除旧文档失败:', collectionName, oldId, (err && err.errMsg) || err));
      return;
    }

    const data = Object.assign({}, d);
    delete data._id;
    delete data._openid; // 由云开发按当前用户自动注入
    col.doc(String(key)).set({ data: data })
      .then(() => col.doc(oldId).remove())
      .then(() => { if (m) m[String(key)] = String(key); })
      .catch((err) => {
        console.error('[cb] 归一 _id 失败:', collectionName, oldId, (err && err.errMsg) || err);
      });
  });
}

// ---------- marks ----------

/** 拉云端标记：[{ adcode, status, name, center, updatedAt }]；失败 null */
function fetchMarks() {
  return ready().then(() => {
    if (!envConfigured()) return null;
    return fetchAll('marks').then((docs) => {
      if (!docs) return null;
      normalizeIds('marks', docs, (d) => d.adcode || '');
      return docs.slice(0, MARKS_LIMIT).map((d) => ({
        adcode: d.adcode || d._id,
        status: d.status,
        name: d.name || '',
        center: d.center || null,
        updatedAt: d.updatedAt || 0
      }));
    });
  });
}

/** 写/删一条标记（status 空 = 删除），doc _id 即 adcode */
function pushMark(doc) {
  return ready().then(() => {
    if (!envConfigured()) return false;
    const col = db().collection('marks');
    const targetId = resolveId('marks', doc.adcode);
    if (!doc.status) {
      return col.doc(String(targetId)).remove()
        .then(() => true)
        .catch((err) => {
          // 文档不存在视为已删
          if (err && /not exist|document/i.test(err.errMsg || '')) return true;
          console.error('[cb] 删标记失败:', (err && err.errMsg) || err);
          return false;
        });
    }
    return col.doc(String(targetId)).set({
      data: {
        adcode: doc.adcode,
        status: doc.status,
        name: doc.name || '',
        center: doc.center || null,
        updatedAt: doc.updatedAt || Date.now()
      }
    }).then(() => true).catch((err) => {
      console.error('[cb] 写标记失败:', (err && err.errMsg) || err);
      return false;
    });
  });
}

// ---------- 通用集合（diaries / chats / memories） ----------

/** 拉当前用户在某集合的全部文档（权限规则自动按 _openid 过滤） */
function listDocs(collectionName) {
  return ready().then(() => {
    if (!envConfigured()) return null;
    return fetchAll(collectionName).then((docs) => {
      // 日记按 date、对话固定 history 作为业务键
      normalizeIds(collectionName, docs, (d) => {
        if (collectionName === 'diaries') return d.date || '';
        if (collectionName === 'chats') return 'history';
        return '';
      });
      return docs;
    });
  });
}

/** 覆盖写一条；id 由业务决定（标记用 adcode、日记用日期） */
function setDoc(collectionName, id, data) {
  return ready().then(() => {
    if (!envConfigured()) return false;
    return db().collection(collectionName).doc(String(resolveId(collectionName, id))).set({ data: data })
      .then(() => true)
      .catch((err) => {
        console.error('[cb] setDoc 失败:', collectionName, (err && err.errMsg) || err);
        return false;
      });
  });
}

function removeDoc(collectionName, id) {
  return ready().then(() => {
    if (!envConfigured()) return false;
    return db().collection(collectionName).doc(String(resolveId(collectionName, id))).remove()
      .then(() => true)
      .catch((err) => {
        if (err && /not exist|document/i.test(err.errMsg || '')) return true;
        console.error('[cb] removeDoc 失败:', collectionName, (err && err.errMsg) || err);
        return false;
      });
  });
}

/** 清空当前用户在某个集合的全部文档；返回删除条数（-1 表示失败） */
function clearCollection(collectionName) {
  return ready().then(() => {
    if (!envConfigured()) return -1;
    // 客户端无 where().remove()，只能逐条删
    return fetchAll(collectionName).then((docs) => {
      if (!docs) return -1;
      const col = db().collection(collectionName);
      const jobs = docs.map((d) => col.doc(d._id).remove().catch(() => null));
      return Promise.all(jobs).then((rs) => rs.filter(Boolean).length);
    });
  });
}

// ---------- 云存储（回忆照片） ----------

/** 从本地路径猜扩展名，默认 jpg */
function guessExt(localPath) {
  const m = /\.([A-Za-z0-9]+)(?:\?|$)/.exec(String(localPath || ''));
  const e = m ? m[1].toLowerCase() : 'jpg';
  return /^(jpg|jpeg|png|webp)$/.test(e) ? e : 'jpg';
}

/**
 * 上传一张本地图片到云存储 → { fileID }
 * 失败 resolve null，由业务层降级用本地路径展示。
 * 走 wx.cloud.uploadFile，无旧网关 base64 2MB 限制（调用方仍应压缩省流量）。
 */
function uploadImage(localPath, ext) {
  if (!localPath || !envConfigured()) return Promise.resolve(null);
  const e = ext || guessExt(localPath);
  const cloudPath = 'photos/' + Date.now().toString(36) + '_' +
    Math.random().toString(36).slice(2, 8) + '.' + e;
  return wx.cloud.uploadFile({
    cloudPath: cloudPath,
    filePath: localPath
  }).then((r) => (r && r.fileID ? { fileID: r.fileID } : null))
    .catch((err) => {
      console.error('[cb] 上传失败:', (err && err.errMsg) || err);
      return null;
    });
}

/** 批量 fileID → 临时链接（默认 2 小时），返回 { fileID: url } */
function getFileUrls(fileIDs) {
  const ids = (fileIDs || []).filter(Boolean);
  if (!ids.length || !envConfigured()) return Promise.resolve({});
  return wx.cloud.getTempFileURL({ fileList: ids }).then((r) => {
    const map = {};
    ((r && r.fileList) || []).forEach((it) => {
      if (it && it.fileID && it.tempFileURL) map[it.fileID] = it.tempFileURL;
    });
    return map;
  }).catch((err) => {
    console.error('[cb] 取临时链接失败:', (err && err.errMsg) || err);
    return {};
  });
}

/** 删除云存储文件（条目删除时清理，失败静默容忍孤儿） */
function deleteFiles(fileIDs) {
  const ids = (fileIDs || []).filter(Boolean);
  if (!ids.length || !envConfigured()) return Promise.resolve(false);
  return wx.cloud.deleteFile({ fileList: ids }).then(() => true)
    .catch((err) => {
      console.error('[cb] 删文件失败:', (err && err.errMsg) || err);
      return false;
    });
}

// ---------- attractions（公开只读，直连） ----------

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
 * 该集合权限档需设为「所有用户可读」（控制台手动配置）。
 */
function fetchAttractions(adcode, fallbackCode, limit) {
  limit = limit || 6;
  const hit = readCache(adcode);
  if (hit) return Promise.resolve(hit);

  return ready().then(() => {
    if (!envConfigured()) return Promise.resolve([]);
    const _ = db().command;
    const where = fallbackCode && fallbackCode !== adcode
      ? { adcode: _.in([String(adcode), String(fallbackCode)]) }
      : { adcode: String(adcode) };
    return db().collection('attractions').where(where).limit(limit).get().then((res) => {
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
      console.error('[cb] 查询景点失败:', adcode, (err && err.errMsg) || err);
      return [];
    });
  });
}

/* @dev:begin */
/**
 * 按需生成景点推荐：wx.cloud.callFunction('genAttraction')。
 * LLM 的 key 只存在云函数环境变量里，客户端不持有、不透传。
 * 注意：模型生成本身要 15~30s，云函数需在 config.json 配 timeout 55s 以上。
 */
function genAttractions(adcode, regionName, parentName) {
  return ready().then(() => {
    if (!envConfigured()) return Promise.reject(new Error('未配置云开发环境'));
    return wx.cloud.callFunction({
      name: 'genAttraction',
      data: { adcode: adcode, name: regionName, parent: parentName || '' }
    }).then((r) => {
      const res = r && r.result;
      if (res && res.code === 0 && Array.isArray(res.list) && res.list.length) {
        writeCache(adcode, res.list);
        return res.list;
      }
      if (res && res.code === 2) throw new Error('服务端未配置 SILICONFLOW_KEY');
      throw new Error((res && res.msg) || '生成失败');
    }).catch((err) => {
      const m = String((err && err.errMsg) || err.message || err);
      if (/timeout/i.test(m)) throw new Error('生成超时，稍后再试');
      throw new Error(m || '生成失败');
    });
  });
}
/* @dev:end */

module.exports = {
  ready,
  sdkAvailable,
  envConfigured,
  cloudReady,
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
