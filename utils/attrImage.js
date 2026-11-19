/**
 * 景区主图缓存：fileID → 本地永久路径
 *
 * 图不进包（358 家各配图会直接撑爆主包），全部走云存储按需下载。
 * 命中判定走 storage 索引（fileID 指纹 → { p, size, at }），
 * 总容量超过 50MB 按 LRU 淘汰；下载失败返回空串，由页面降级渐变底。
 */
const DIR = wx.env.USER_DATA_PATH + '/attr/img';
const INDEX_KEY = 'travel.attrImgIndex';
const MAX_BYTES = 50 * 1024 * 1024;

const fs = wx.getFileSystemManager();
const pending = {};

function hash(s) {
  let h = 5381;
  const t = String(s || '');
  for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function ensureDir() {
  try {
    fs.accessSync(DIR);
  } catch (e) {
    try { fs.mkdirSync(DIR, true); } catch (e2) { /* ignore */ }
  }
}

function readIndex() {
  const v = wx.getStorageSync(INDEX_KEY);
  return v && typeof v === 'object' ? v : {};
}

function writeIndex(idx) {
  try { wx.setStorageSync(INDEX_KEY, idx); } catch (e) { /* ignore */ }
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch (e) {
    return false;
  }
}

/** 超过容量上限时按 at 从旧到新删，直到回到预算内 */
function evict(idx) {
  const keys = Object.keys(idx);
  let total = keys.reduce((n, k) => n + (idx[k].size || 0), 0);
  if (total <= MAX_BYTES) return;
  keys.sort((a, b) => (idx[a].at || 0) - (idx[b].at || 0));
  for (const k of keys) {
    if (total <= MAX_BYTES) break;
    try { fs.unlinkSync(idx[k].p); } catch (e) { /* 文件可能已被系统清理 */ }
    total -= idx[k].size || 0;
    delete idx[k];
  }
  writeIndex(idx);
}

function guessExt(fileID) {
  const m = /\.([A-Za-z0-9]+)(?:\?|$)/.exec(String(fileID || ''));
  const e = m ? m[1].toLowerCase() : 'jpg';
  return /^(jpg|jpeg|png|webp)$/.test(e) ? e : 'jpg';
}

/**
 * 取本地路径；无 fileID / 下载失败 / 无云环境 → 空串。
 * 同一 fileID 并发调用只下载一次。
 */
function resolve(fileID) {
  const id = String(fileID || '');
  if (!id) return Promise.resolve('');

  const key = hash(id);
  const idx = readIndex();
  const hit = idx[key];
  if (hit && hit.p && exists(hit.p)) {
    hit.at = Date.now();
    idx[key] = hit;
    writeIndex(idx);
    return Promise.resolve(hit.p);
  }
  if (pending[key]) return pending[key];

  const p = new Promise((resolveOut) => {
    let cloud;
    try { cloud = wx.cloud; } catch (e) { cloud = null; }
    if (!cloud || !cloud.downloadFile) { resolveOut(''); return; }

    ensureDir();
    const dest = DIR + '/' + key + '.' + guessExt(id);
    cloud.downloadFile({ fileID: id }).then((r) => {
      const temp = r && r.tempFilePath;
      if (!temp) { resolveOut(''); return; }
      // 临时路径重启即失效，必须落成永久文件
      fs.copyFile({
        srcPath: temp,
        destPath: dest,
        success: () => {
          let size = 0;
          try { size = fs.statSync(dest).size || 0; } catch (e) { size = 0; }
          const next = readIndex();
          next[key] = { p: dest, size: size, at: Date.now() };
          writeIndex(next);
          evict(next);
          resolveOut(dest);
        },
        fail: () => resolveOut('')
      });
    }).catch(() => resolveOut(''));
  }).then((r) => {
    delete pending[key];
    return r;
  });

  pending[key] = p;
  return p;
}

/** 清空图片缓存（「我的」页清理入口备用） */
function clearAll() {
  const idx = readIndex();
  Object.keys(idx).forEach((k) => {
    try { fs.unlinkSync(idx[k].p); } catch (e) { /* ignore */ }
  });
  writeIndex({});
}

module.exports = { resolve, clearAll };
