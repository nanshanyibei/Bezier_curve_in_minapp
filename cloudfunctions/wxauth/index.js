/**
 * 云函数 wxauth —— 小程序身份 + 数据网关
 *
 * 为什么要有这一层：
 *   环境未开通「微信小程序登录」provider 通道（provider/token 恒返回 404），
 *   createTicket 又必须有私钥文件（云函数环境身份不够）。
 *   所以身份只能由本函数用 AppSecret 自己换 openid，数据读写也只能由本函数代理，
 *   客户端不再直连数据库（集合权限档请设为 ADMINONLY）。
 *
 * 入参：
 *   { action: 'login', code }                        → { code:0, openid, token }
 *   { action: 'pull',  token, col }                   → { code:0, list }
 *   { action: 'put',   token, col, id, data }         → { code:0 }
 *   { action: 'del',   token, col, id }               → { code:0 }
 *   { action: 'upload',   token, base64, ext }        → { code:0, fileID }
 *   { action: 'fileUrl',  token, fileIDs }            → { code:0, list:[{fileID,tempFileURL}] }
 *   { action: 'delFiles', token, fileIDs }            → { code:0, n }
 *   { action: 'probeDb' }                             → 诊断用
 *   { action: 'owners', key }                         → 各集合 owner 及条数（换 AppID 迁移前摸底）
 *   { action: 'migrate', key, mapping, dryRun, deleteOld }
 *                                                     → 把旧 openid 的数据搬到新 openid
 *   { code }（无 action，兼容旧调用）                  → 同 login
 *
 * 环境变量：WX_APPID、WX_SECRET、MIGRATE_KEY（仅换 AppID 迁移期需要，迁移完可删）
 * 安全：openid 只在服务端出现；客户端只持有 HMAC 签名 token；每条文档强制带 owner=openid。
 * 存储：路径强制带 openid 前缀 memories/<openid>/…，删除时校验前缀，防止删他人文件。
 */
const cloudbase = require('@cloudbase/node-sdk');
const https = require('https');
const crypto = require('crypto');

const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });
const db = app.database();

const APPID = process.env.WX_APPID;
const SECRET = process.env.WX_SECRET;
const MIGRATE_KEY = process.env.MIGRATE_KEY || '';

const TOKEN_TTL = 30 * 24 * 3600 * 1000; // 30 天
const ALLOWED_COLS = { marks: 1, diaries: 1, chats: 1, memories: 1 };

// 图片上传限制：压缩后正常 200–400KB，base64 膨胀约 1.33 倍。
// 网关与云函数 event 都有体积上限，超过 2MB 直接拒绝，避免整包失败。
const UPLOAD_MAX_BASE64 = 2 * 1024 * 1024;
const EXT_ALLOW = { jpg: 1, jpeg: 1, png: 1, webp: 1 };
const STORAGE_PREFIX = 'memories';

/** 微信 code2session */
function code2Session(code) {
  return new Promise((resolve, reject) => {
    const url = 'https://api.weixin.qq.com/sns/jscode2session'
      + '?appid=' + encodeURIComponent(APPID)
      + '&secret=' + encodeURIComponent(SECRET)
      + '&js_code=' + encodeURIComponent(code)
      + '&grant_type=authorization_code';
    const req = https.get(url, { timeout: 8000 }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('wx 响应解析失败: ' + raw.slice(0, 120))); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('wx 接口超时')); });
    req.on('error', reject);
  });
}

// ---------- token ----------

function tokenKey() {
  return crypto.createHash('sha256').update('tcb|' + APPID + '|' + SECRET).digest();
}

function signToken(openid) {
  const payload = Buffer.from(JSON.stringify({ o: openid, e: Date.now() + TOKEN_TTL })).toString('base64url');
  const sig = crypto.createHmac('sha256', tokenKey()).update(payload).digest('base64url');
  return payload + '.' + sig;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return '';
  const parts = token.split('.');
  if (parts.length !== 2) return '';
  const expect = crypto.createHmac('sha256', tokenKey()).update(parts[0]).digest('base64url');
  const a = Buffer.from(parts[1]);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return '';
  try {
    const obj = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (!obj || !obj.o || !obj.e || obj.e < Date.now()) return '';
    return obj.o;
  } catch (e) {
    return '';
  }
}

// ---------- 数据访问 ----------

function docId(openid, id) {
  return openid + '_' + String(id).replace(/[^A-Za-z0-9_.-]/g, '');
}

function assertCol(col) {
  if (!ALLOWED_COLS[col]) throw new Error('COLLECTION_NOT_ALLOWED: ' + col);
  return col;
}

/** pgdoc 物理结构是 { _id, data: {...} }，读回来要展平 */
function unwrap(d) {
  const body = (d && d.data && typeof d.data === 'object') ? d.data : {};
  return Object.assign({}, body, { _id: d && d._id });
}

/** 拉当前用户在某集合的全部文档（不含 owner 字段） */
async function pull(openid, col) {
  assertCol(col);
  let raw = [];
  // pgdoc 下 where 对 data 内字段的路径写法不稳定，先试点路径
  try {
    const r = await db.collection(col).where({ 'data.owner': openid }).limit(500).get();
    raw = r.data || [];
  } catch (e) {
    raw = [];
  }
  if (!raw.length) {
    // 条件没命中或语法不支持：退回全量后本地过滤（安全边界不变，只返回本人）
    const r2 = await db.collection(col).limit(500).get();
    raw = r2.data || [];
  }
  return raw.map(unwrap).filter((d) => d.owner === openid)
    .map((d) => { const o = Object.assign({}, d); delete o.owner; return o; });
}

/** 覆盖写一条：_id 与 owner 都由服务端决定，客户端改不了归属 */
async function put(openid, col, id, data) {
  assertCol(col);
  if (id === undefined || id === null || id === '') throw new Error('MISSING_ID');
  const doc = Object.assign({}, data || {}, { owner: openid });
  await db.collection(col).doc(docId(openid, id)).set({ data: doc });
}

async function del(openid, col, id) {
  assertCol(col);
  if (id === undefined || id === null || id === '') throw new Error('MISSING_ID');
  await db.collection(col).doc(docId(openid, id)).remove();
}

// ---------- 云存储（回忆照片） ----------

/** 只认自己前缀下的文件，防止拿到别人 fileID 后删掉 */
function assertOwnFile(openid, fileID) {
  const s = String(fileID || '');
  if (!s) throw new Error('MISSING_FILE');
  if (s.indexOf('/' + STORAGE_PREFIX + '/' + openid + '/') < 0) {
    throw new Error('FILE_NOT_OWNED');
  }
  return s;
}

/**
 * base64 → 云存储，返回 fileID
 * 客户端先压缩再读 base64（不含 data:image/xxx;base64, 前缀）
 */
async function upload(openid, base64, ext) {
  const e = String(ext || 'jpg').toLowerCase().replace(/^\./, '');
  if (!EXT_ALLOW[e]) throw new Error('EXT_NOT_ALLOWED: ' + e);
  const raw = String(base64 || '');
  if (!raw) throw new Error('MISSING_CONTENT');
  if (raw.length > UPLOAD_MAX_BASE64) throw new Error('FILE_TOO_LARGE: ' + raw.length);
  const buf = Buffer.from(raw, 'base64');
  if (!buf || !buf.length) throw new Error('BAD_BASE64');
  const cloudPath = STORAGE_PREFIX + '/' + openid + '/'
    + Date.now() + '_' + crypto.randomBytes(4).toString('hex') + '.' + e;
  const res = await app.uploadFile({ cloudPath: cloudPath, fileContent: buf });
  return (res && res.fileID) || '';
}

/** fileID → 临时链接（默认 2 小时有效），供 <image> 直接渲染 */
async function fileUrl(openid, fileIDs) {
  const ids = (Array.isArray(fileIDs) ? fileIDs : []).slice(0, 20)
    .map((f) => assertOwnFile(openid, f));
  if (!ids.length) return [];
  const res = await app.getTempFileURL({ fileList: ids });
  return ((res && res.fileList) || []).map((it) => ({
    fileID: it.fileID,
    tempFileURL: it.tempFileURL || '',
    code: it.code || ''
  }));
}

async function delFiles(openid, fileIDs) {
  const ids = (Array.isArray(fileIDs) ? fileIDs : []).slice(0, 20)
    .map((f) => assertOwnFile(openid, f));
  if (!ids.length) return 0;
  const res = await app.deleteFile({ fileList: ids });
  const list = (res && res.fileList) || [];
  return list.filter((it) => !it.code || it.code === 'SUCCESS' || it.code === 'success').length;
}

// ---------- 换 AppID 数据迁移（临时管理入口） ----------
/* 换小程序后 openid 会变，旧数据全部挂在旧 openid 名下、客户端读不到。
 * 这里只做「按显式映射搬文档 + 搬照片文件」，不做任何自动认领：
 * openid 跨 AppID 没有换算关系，必须由人手给出 from → to 对应关系。
 * 配了 MIGRATE_KEY 才可用，迁移完删掉该环境变量即可关闭入口。 */

const MIGRATE_COLS = ['marks', 'diaries', 'chats', 'memories'];
// 单次拉取上限：与 pull() 一致，pgdoc 下 skip 分页不稳，宁可显式报「可能未取全」
const MIGRATE_LIMIT = 500;
const STORAGE_PREFIX_SEG = '/' + STORAGE_PREFIX + '/';

/** 全量取某集合（管理端视角，不按 owner 过滤）→ { list, truncated } */
async function listAll(col) {
  const r = await db.collection(col).limit(MIGRATE_LIMIT).get();
  const rows = (r && r.data) || [];
  if (rows.length >= MIGRATE_LIMIT) console.warn('[wxauth] ' + col + ' 达到上限 ' + MIGRATE_LIMIT + '，可能未取全');
  return { list: rows.map(unwrap), truncated: rows.length >= MIGRATE_LIMIT };
}

/** 云存储文件复制到新 openid 前缀，返回新 fileID；非本人前缀或失败返回空串 */
async function copyFileToOwner(from, to, fileID) {
  const needle = STORAGE_PREFIX_SEG + from + '/';
  const s = String(fileID || '');
  const at = s.indexOf(needle);
  if (at < 0) return '';
  const down = await app.downloadFile({ fileID: s });
  const buf = down && down.fileContent;
  if (!buf || !buf.length) return '';
  const cloudPath = STORAGE_PREFIX + '/' + to + '/' + s.slice(at + needle.length);
  const up = await app.uploadFile({ cloudPath: cloudPath, fileContent: buf });
  return (up && up.fileID) || '';
}

/** 各集合的 owner 分布，迁移前摸底 */
async function ownersReport() {
  const out = {};
  for (const col of MIGRATE_COLS) {
    try {
      const r = await listAll(col);
      const map = {};
      for (const d of r.list) {
        const k = d.owner || '(none)';
        map[k] = (map[k] || 0) + 1;
      }
      out[col] = { total: r.list.length, truncated: r.truncated, owners: map };
    } catch (err) {
      out[col] = { error: (err && err.message) || String(err) };
    }
  }
  return out;
}

/** mapping: [{ from, to }]；dryRun 默认 true，只有显式 false 才真正写 */
async function migrateOwners(mapping, opts) {
  const dryRun = opts.dryRun !== false;
  const report = { dryRun: dryRun, deleteOld: !!opts.deleteOld, cols: {} };
  for (const col of MIGRATE_COLS) {
    const stat = { scanned: 0, moved: 0, skipped: 0, files: 0, fileFailed: 0, truncated: false, errors: [] };
    report.cols[col] = stat;
    let docs = [];
    try {
      const r = await listAll(col);
      docs = r.list;
      stat.truncated = r.truncated;
    } catch (err) {
      stat.errors.push('LIST_FAIL: ' + ((err && err.message) || err));
      continue;
    }
    stat.scanned = docs.length;
    for (const d of docs) {
      let hit = null;
      for (const m of mapping) { if (m.from === d.owner) { hit = m; break; } }
      if (!hit) continue;
      const prefix = hit.from + '_';
      if (String(d._id).indexOf(prefix) !== 0) {
        stat.skipped++;
        stat.errors.push('ID_PREFIX_MISMATCH: ' + d._id);
        continue;
      }
      const suffix = String(d._id).slice(prefix.length);
      const body = Object.assign({}, d);
      delete body._id;
      delete body.owner;

      if (col === 'memories' && Array.isArray(body.photos)) {
        for (const p of body.photos) {
          if (!p || !p.fileID) continue;
          if (dryRun) continue;
          try {
            const nf = await copyFileToOwner(hit.from, hit.to, p.fileID);
            if (nf) { p.fileID = nf; stat.files++; }
            else if (String(p.fileID).indexOf(STORAGE_PREFIX_SEG + hit.from + '/') >= 0) stat.fileFailed++;
          } catch (err) {
            stat.fileFailed++;
          }
        }
      }

      if (dryRun) { stat.moved++; continue; }
      try {
        await db.collection(col).doc(docId(hit.to, suffix))
          .set({ data: Object.assign(body, { owner: hit.to }) });
        if (opts.deleteOld) await db.collection(col).doc(d._id).remove();
        stat.moved++;
      } catch (err) {
        stat.errors.push('WRITE_FAIL: ' + d._id + ': ' + ((err && err.message) || err));
      }
    }
  }
  return report;
}

// ---------- 入口 ----------

/**
 * 统一入参形态：
 *   - SDK callFunction：直接是业务对象
 *   - HTTP 网关 / HTTP 访问服务：包成 { path, httpMethod, headers, body, ... }，业务在 body（字符串）
 */
function normalizeEvent(raw) {
  let e = raw || {};
  if (typeof e === 'string') {
    try { e = JSON.parse(e); } catch (err) { e = {}; }
  }
  if (e && (typeof e.body === 'string' || (e.body && typeof e.body === 'object'))) {
    let b = e.body;
    if (typeof b === 'string') {
      try { b = JSON.parse(b); } catch (err) { b = null; }
    }
    if (b && typeof b === 'object') e = Object.assign({}, b, { __http: true });
  }
  return e;
}

exports.main = async (event) => {
  const e = normalizeEvent(event);
  const action = e.action || (e.code ? 'login' : '');

  if (action === 'login') {
    const code = e.code;
    if (!code) return { code: 1, msg: 'MISSING_CODE' };
    if (!APPID || !SECRET) return { code: 2, msg: 'MISSING_ENV: WX_APPID / WX_SECRET 未配置' };

    let session;
    try {
      session = await code2Session(code);
    } catch (err) {
      return { code: 3, msg: 'WX_API_UNREACHABLE: ' + ((err && err.message) || err) };
    }
    if (!session || session.errcode) {
      return {
        code: 4,
        msg: 'WX_API_ERROR: ' + ((session && session.errmsg) || 'unknown'),
        errcode: session && session.errcode
      };
    }
    const openid = session.openid || '';
    if (!openid) return { code: 5, msg: 'NO_OPENID' };
    return { code: 0, openid: openid, token: signToken(openid), unionid: session.unionid || '' };
  }

  // 迁移入口：不走小程序 token，用独立管理密钥；未配 MIGRATE_KEY 时整体关闭
  if (action === 'owners' || action === 'migrate') {
    if (!MIGRATE_KEY || !e.key || e.key !== MIGRATE_KEY) {
      return { code: 403, msg: 'MIGRATE_DISABLED' };
    }
    try {
      if (action === 'owners') return { code: 0, cols: await ownersReport() };
      const mapping = (Array.isArray(e.mapping) ? e.mapping : [])
        .filter((m) => m && m.from && m.to && m.from !== m.to);
      if (!mapping.length) return { code: 1, msg: 'MISSING_MAPPING' };
      const report = await migrateOwners(mapping, { dryRun: e.dryRun, deleteOld: e.deleteOld });
      return { code: 0, report: report };
    } catch (err) {
      return { code: 500, msg: (err && err.message) || String(err) };
    }
  }

  // 以下都要 token
  const openid = verifyToken(e.token);
  if (!openid) return { code: 401, msg: 'INVALID_TOKEN' };

  try {
    if (action === 'pull') {
      return { code: 0, list: await pull(openid, e.col) };
    }
    if (action === 'put') {
      await put(openid, e.col, e.id, e.data);
      return { code: 0 };
    }
    if (action === 'del') {
      await del(openid, e.col, e.id);
      return { code: 0 };
    }
    if (action === 'upload') {
      const fileID = await upload(openid, e.base64, e.ext);
      return { code: 0, fileID: fileID };
    }
    if (action === 'fileUrl') {
      return { code: 0, list: await fileUrl(openid, e.fileIDs) };
    }
    if (action === 'delFiles') {
      return { code: 0, n: await delFiles(openid, e.fileIDs) };
    }
    if (action === 'clear') {
      // 清空本人该集合的全部文档（先按 owner 过滤，再逐条删，避免误伤他人）
      const list = await pull(openid, e.col);
      let n = 0;
      for (const d of list) {
        if (!d || !d._id) continue;
        try {
          await db.collection(e.col).doc(d._id).remove();
          n++;
        } catch (err) { /* 单条失败不影响其余 */ }
      }
      return { code: 0, n: n };
    }
  } catch (err) {
    return { code: 500, msg: (err && err.message) || String(err) };
  }

  return { code: 404, msg: 'UNKNOWN_ACTION: ' + action };
};
