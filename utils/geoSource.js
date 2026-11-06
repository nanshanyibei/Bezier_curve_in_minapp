/**
 * 地理边界数据源：下载 → 文件缓存（USER_DATA_PATH/geo/）→ 内存缓存
 * 数据源：阿里 DataV GeoAtlas（静态行政边界 GeoJSON，含九段线）
 * 下载主通道 wx.request（文本直取，少一次临时文件拷贝），downloadFile 作降级。
 * 先 JSON.parse 校验再写缓存，避免坏响应（错误页/截断）污染本地缓存。
 * storage 只存下载索引（LRU 依据），不存数据本体。
 */
const config = require('../config');

const INDEX_KEY = 'travel.geoIndex';
const DIR = wx.env.USER_DATA_PATH + '/geo';
const fs = wx.getFileSystemManager();
const memCache = {};

function ensureDir() {
  try {
    fs.accessSync(DIR);
  } catch (e) {
    try { fs.mkdirSync(DIR, true); } catch (e2) { /* 目录创建失败时写文件会再报错 */ }
  }
}

function filePath(adcode) {
  return DIR + '/' + adcode + '_full.json';
}

function readIndex() {
  const idx = wx.getStorageSync(INDEX_KEY);
  return idx && typeof idx === 'object' ? idx : {};
}

function writeIndex(idx) {
  wx.setStorageSync(INDEX_KEY, idx);
}

function readLocal(adcode) {
  return new Promise((resolve) => {
    try {
      ensureDir();
      fs.readFile({
        filePath: filePath(adcode),
        encoding: 'utf8',
        success: (res) => resolve(res.data),
        fail: () => resolve(null)
      });
    } catch (e) {
      resolve(null);
    }
  });
}

/** 文本直写缓存 */
function writeLocal(adcode, text) {
  return new Promise((resolve, reject) => {
    try {
      ensureDir();
      fs.writeFile({
        filePath: filePath(adcode),
        data: text,
        encoding: 'utf8',
        success: () => resolve(),
        fail: (err) => reject(new Error('缓存写入失败：' + (err && err.errMsg || '')))
      });
    } catch (e) {
      reject(e);
    }
  });
}

function removeLocal(adcode) {
  try { fs.unlinkSync(filePath(adcode)); } catch (e) { /* 不存在则忽略 */ }
}

/** LRU：超过 GEO_CACHE_MAX 时按 ts 淘汰最旧（保留 keepAdcode） */
function pruneCache(keepAdcode) {
  const idx = readIndex();
  const keys = Object.keys(idx)
    .filter((k) => k !== keepAdcode)
    .sort((a, b) => idx[a].ts - idx[b].ts);
  while (keys.length + 1 > config.GEO_CACHE_MAX) {
    const k = keys.shift();
    removeLocal(k);
    delete idx[k];
  }
  writeIndex(idx);
}

/** 主通道：wx.request 文本直取 */
function fetchText(adcode) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: config.GEO_BASE + adcode + '_full.json',
      method: 'GET',
      timeout: config.TIMEOUT,
      responseType: 'text',
      dataType: '其他', // 关闭自动 JSON.parse，拿到原始文本统一处理
      success: (res) => {
        if (res.statusCode !== 200) {
          reject(new Error('HTTP ' + res.statusCode + '（wx.request）'));
          return;
        }
        if (typeof res.data !== 'string' || !res.data) {
          reject(new Error('响应体为空（wx.request）'));
          return;
        }
        resolve(res.data);
      },
      fail: (err) => reject(new Error('wx.request fail: ' + ((err && err.errMsg) || '未知')))
    });
  });
}

/** 降级通道：wx.downloadFile（下载到临时文件后回读文本） */
function fetchFile(adcode) {
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url: config.GEO_BASE + adcode + '_full.json',
      timeout: config.TIMEOUT,
      success: (res) => {
        if (res.statusCode !== 200 || !res.tempFilePath) {
          reject(new Error('HTTP ' + res.statusCode + '（wx.downloadFile）'));
          return;
        }
        fs.readFile({
          filePath: res.tempFilePath,
          encoding: 'utf8',
          success: (r) => resolve(r.data),
          fail: (err) => reject(new Error('临时文件回读失败：' + ((err && err.errMsg) || '')))
        });
      },
      fail: (err) => reject(new Error('wx.downloadFile fail: ' + ((err && err.errMsg) || '未知')))
    });
  });
}

/** 下载原始文本：request 主通道失败时降级 downloadFile */
function fetchRaw(adcode, onProgress) {
  return fetchText(adcode).catch((err1) => {
    return fetchFile(adcode).catch((err2) => {
      throw new Error(err1.message + '；降级亦失败 → ' + err2.message);
    });
  });
}

/**
 * 加载原始 GeoJSON 文本：内存 → 本地文件 → 网络（整体重试 2 次，指数退避）
 * 网络结果先 JSON 校验再落盘，坏数据不缓存。
 */
function loadRaw(adcode, opts) {
  opts = opts || {};
  if (memCache[adcode]) return Promise.resolve(memCache[adcode]);

  return readLocal(adcode).then((raw) => {
    if (raw !== null && raw !== undefined && raw !== '') {
      try {
        JSON.parse(raw);
        memCache[adcode] = raw;
        return raw;
      } catch (e) {
        // 本地缓存损坏：清除后走网络
        removeLocal(adcode);
      }
    }
    const attempt = (n) => fetchRaw(adcode, opts.onProgress)
      .then((text) => {
        JSON.parse(text); // 校验，坏响应在此抛错不落盘
        return writeLocal(adcode, text).then(() => {
          memCache[adcode] = text;
          const idx = readIndex();
          idx[adcode] = { ts: Date.now() };
          writeIndex(idx);
          pruneCache(adcode);
          return text;
        });
      })
      .catch((err) => {
        // 确保失败不留半截缓存
        removeLocal(adcode);
        if (n < 2) {
          return new Promise((r) => setTimeout(r, 800 * (n + 1))).then(() => attempt(n + 1));
        }
        throw err;
      });
    return attempt(0);
  });
}

/** 加载并校验 FeatureCollection */
function loadGeoJSON(adcode, opts) {
  return loadRaw(adcode, opts).then((raw) => {
    let fc;
    try {
      fc = JSON.parse(raw);
    } catch (e) {
      throw new Error('地图数据解析失败');
    }
    if (!fc || fc.type !== 'FeatureCollection' || !fc.features || !fc.features.length) {
      throw new Error('地图数据格式异常');
    }
    return fc;
  });
}

function clearAll() {
  Object.keys(memCache).forEach((k) => delete memCache[k]);
  try {
    wx.removeStorageSync(INDEX_KEY);
  } catch (e) { /* 忽略 */ }
  try {
    ensureDir();
    fs.readdirSync(DIR).forEach((name) => {
      try { fs.unlinkSync(DIR + '/' + name); } catch (e) { /* 忽略 */ }
    });
  } catch (e) { /* 忽略 */ }
}

module.exports = { loadRaw, loadGeoJSON, filePath, clearAll };
