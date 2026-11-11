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
 *   { action: 'probeDb' }                             → 诊断用
 *   { code }（无 action，兼容旧调用）                  → 同 login
 *
 * 环境变量：WX_APPID、WX_SECRET
 * 安全：openid 只在服务端出现；客户端只持有 HMAC 签名 token；每条文档强制带 owner=openid。
 */
const cloudbase = require('@cloudbase/node-sdk');
const https = require('https');
const crypto = require('crypto');

const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });
const db = app.database();

const APPID = process.env.WX_APPID;
const SECRET = process.env.WX_SECRET;

const TOKEN_TTL = 30 * 24 * 3600 * 1000; // 30 天
const ALLOWED_COLS = { marks: 1, diaries: 1, chats: 1 };

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
