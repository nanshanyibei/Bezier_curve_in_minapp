/**
 * 云函数 genAttraction：按需生成景点推荐
 *
 * 入参（HTTP 网关路由 /genAttraction，body 即业务参数）：
 *   { adcode, name, parent?, token, llmKey? }
 * 流程：校验身份 → 已有 llm 数据则直接返回 → LLM 生成 5 条 → 校验 → 写 attractions → 返回全量
 *
 * 环境变量：
 *   WX_APPID / WX_SECRET   与 wxauth 同值；配置后强制校验 token（防止公网裸调烧额度）
 *   SILICONFLOW_KEY        推荐配置；未配置时退用请求体里的 llmKey（开发期过渡，勿长期依赖）
 *   SILICONFLOW_MODEL      可选
 *
 * pgdoc 两个坑（与 wxauth 同源，已处理）：
 *   1. node-sdk 读到的文档是 { _id, data: {...} } 两层，需 unwrap；
 *   2. where 匹配不到顶层字段，要写 'data.adcode'；查不到时退回全表 + JS 过滤。
 */
const cloudbase = require('@cloudbase/node-sdk');
const crypto = require('crypto');

const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });
const db = app.database();

const COL = 'attractions';
const LLM_BASE = 'https://api.siliconflow.cn/v1/chat/completions';
const MODEL = process.env.SILICONFLOW_MODEL || 'deepseek-ai/DeepSeek-V4-Flash';

const APPID = process.env.WX_APPID;
const SECRET = process.env.WX_SECRET;
const MAX_LLM_SPOTS = 12; // 单 adcode 的 llm 数据上限，超过不再调模型

/** HTTP 网关路由下 event 被包成 { path, httpMethod, headers, body } */
function normalizeEvent(event) {
  let e = event || {};
  if (typeof e.body === 'string') {
    try { e = JSON.parse(e.body); } catch (err) { e = {}; }
  } else if (e.body && typeof e.body === 'object') {
    e = e.body;
  }
  return e || {};
}

// ---------- token（与 wxauth 同算法） ----------

function tokenKey() {
  return crypto.createHash('sha256').update('tcb|' + APPID + '|' + SECRET).digest();
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

/** 应用密钥：环境变量优先，其次请求体透传（开发期过渡） */
function llmKey(e) {
  return process.env.SILICONFLOW_KEY || (e && e.llmKey) || '';
}

/** 剥掉 pgdoc 的 data 包装 */
function unwrap(d) {
  if (d && d.data && typeof d.data === 'object' && !Array.isArray(d.data)) {
    return Object.assign({ _id: d._id }, d.data);
  }
  return d;
}

function shape(d) {
  return {
    name: d.name || '',
    desc: d.desc || '',
    img: d.img || '',
    bestMonths: d.bestMonths || '',
    tags: d.tags || []
  };
}

/** 取某 adcode 下已有景点（两条路径都试，绕开 pgdoc 的 where 语义差异） */
async function listByAdcode(adcode) {
  const key = String(adcode);
  try {
    const r = await db.collection(COL).where({ 'data.adcode': key }).limit(100).get();
    const list = (r.data || []).map(unwrap).filter((d) => String(d.adcode) === key);
    if (list.length) return list;
  } catch (e) { /* 落到全表兜底 */ }
  try {
    const all = await db.collection(COL).limit(500).get();
    return (all.data || []).map(unwrap).filter((d) => String(d.adcode) === key);
  } catch (e) {
    return [];
  }
}

function callLLM(prompt, key) {
  const body = JSON.stringify({
    model: MODEL,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.8,
    max_tokens: 1500
  });
  return new Promise((resolve, reject) => {
    const req = require('https').request(LLM_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + key,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 50000
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error('LLM HTTP ' + res.statusCode + ': ' + raw.slice(0, 200))); return; }
        try {
          resolve(JSON.parse(raw).choices[0].message.content);
        } catch (e) { reject(new Error('LLM 响应解析失败')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('LLM 请求超时')); });
    req.write(body);
    req.end();
  });
}

function extractJson(text) {
  // 剥离 ```json 围栏 / 前后杂文本，取第一个 JSON 数组
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('响应中无 JSON 数组');
  return JSON.parse(text.slice(start, end + 1));
}

function validate(list, adcode) {
  if (!Array.isArray(list)) throw new Error('非数组');
  const seen = {};
  return list.filter((it) => {
    if (!it || typeof it.name !== 'string' || !it.name.trim()) return false;
    if (typeof it.desc !== 'string' || !it.desc.trim() || it.desc.length > 200) return false;
    if (seen[it.name]) return false;
    seen[it.name] = 1;
    return true;
  }).slice(0, 5).map((it) => ({
    adcode: String(adcode),
    name: it.name.trim().slice(0, 30),
    desc: it.desc.trim().slice(0, 200),
    img: '',
    bestMonths: typeof it.bestMonths === 'string' ? it.bestMonths.slice(0, 30) : '',
    tags: Array.isArray(it.tags) ? it.tags.slice(0, 4).map((t) => String(t).slice(0, 10)) : [],
    source: 'llm',
    createdAt: Date.now()
  }));
}

/** 稳定 _id：同一 adcode + 同名景点重跑不重复写 */
function docId(adcode, name) {
  let h = 5381;
  const s = String(name);
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return 'llm_' + adcode + '_' + h.toString(36);
}

async function save(spot) {
  const id = docId(spot.adcode, spot.name);
  try {
    // 直接传文档体，避免 pgdoc 下多包一层 data
    await db.collection(COL).doc(id).set(spot);
  } catch (e) {
    console.error('[genAttraction] set 失败，尝试 add:', e.message);
    await db.collection(COL).add(spot);
  }
}

exports.main = async (event) => {
  const e = normalizeEvent(event);

  // 配了密钥就强制鉴权，避免公网裸调消耗 LLM 额度
  if (APPID && SECRET) {
    const openid = verifyToken(e.token);
    if (!openid) return { code: 401, msg: 'UNAUTHORIZED', list: [] };
  }

  const adcode = e.adcode;
  const name = e.name;
  const parent = e.parent;
  if (!adcode || !name) return { code: 1, msg: '缺少 adcode/name' };

  const key = llmKey(e);
  if (!key) return { code: 2, msg: 'NO_LLM_KEY', list: [] };

  try {
    // 已有足够的 llm 数据就不再调模型（省额度，也防重复触发）
    const exist = await listByAdcode(adcode);
    const llmCount = exist.filter((d) => d.source === 'llm').length;
    if (llmCount >= MAX_LLM_SPOTS) {
      return { code: 0, list: exist.slice(0, 6).map(shape), added: 0, cached: true };
    }

    const scope = parent ? parent + name : name;
    const prompt = '你是旅行顾问。请推荐 ' + scope + '（行政区划代码 ' + adcode + '）最有代表性的 5 个景点或体验，'
      + '每个包含字段：name（名称，不超过15字）、desc（一句话亮点介绍，不超过60字，突出特色，不要套话）、'
      + 'bestMonths（最适合游玩的月份，格式如 "4-6,9-10"，全年皆宜写 "四季皆宜"）、'
      + 'tags（1-3个标签，从 自然/人文/美食/夜景观赏/亲子/徒步/海岛/古镇/冰雪/温泉 中选）。'
      + '只输出 JSON 数组，不要任何其他文字。';

    const content = await callLLM(prompt, key);
    const spots = validate(extractJson(content), adcode);
    if (!spots.length) return { code: 1, msg: '生成结果校验后为空' };

    const have = {};
    exist.forEach((d) => { have[d.name] = 1; });
    const fresh = spots.filter((s) => !have[s.name]);
    for (const s of fresh) await save(s);

    const all = await listByAdcode(adcode);
    return { code: 0, list: all.slice(0, 6).map(shape), added: fresh.length };
  } catch (err) {
    console.error('[genAttraction]', err.message);
    return { code: 1, msg: err.message };
  }
};
