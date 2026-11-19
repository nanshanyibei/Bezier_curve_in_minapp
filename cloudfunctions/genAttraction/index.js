/**
 * 云函数 genAttraction：按需生成景点推荐（2026-11 迁移版，wx-server-sdk）
 *
 * 入参（wx.cloud.callFunction）：{ adcode, name, parent?, apiKey? }
 * 流程：已有足够 llm 数据直接返回 → LLM 生成 5 条 → 校验 → 写 attractions → 返回全量
 * 身份：callFunction 自带微信登录态（getWXContext().OPENID），无需 HMAC token；
 *       客户端匿名无法直调未授权云函数，公网裸调风险天然消除。
 *
 * API Key：优先用客户端透传的 e.apiKey（来自「我的」页统一设置，仅存该用户本机），
 *          未传时回退环境变量 SILICONFLOW_KEY。
 *
 * ⚠️ config.json 已配 timeout 55s：模型生成要 15~30s，默认 3s 会稳定超时。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const COL = 'attractions';
const LLM_BASE = 'https://api.siliconflow.cn/v1/chat/completions';
const MODEL = process.env.SILICONFLOW_MODEL || 'deepseek-ai/DeepSeek-V4-Flash';
const MAX_LLM_SPOTS = 12; // 单 adcode 的 llm 数据上限，超过不再调模型

function shape(d) {
  return {
    name: d.name || '',
    desc: d.desc || '',
    img: d.img || '',
    bestMonths: d.bestMonths || '',
    tags: d.tags || []
  };
}

async function listByAdcode(adcode) {
  const key = String(adcode);
  try {
    const r = await db.collection(COL).where({ adcode: key }).limit(100).get();
    return (r.data || []).filter((d) => String(d.adcode) === key);
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
  await db.collection(COL).doc(spot._id).set(spot);
}

exports.main = async (event) => {
  const e = event || {};
  const adcode = e.adcode;
  const name = e.name;
  const parent = e.parent;
  if (!adcode || !name) return { code: 1, msg: '缺少 adcode/name' };

  const key = (e.apiKey && String(e.apiKey).trim()) || process.env.SILICONFLOW_KEY || '';
  if (!key) {
    console.error('[genAttraction] 客户端未透传 apiKey 且环境变量 SILICONFLOW_KEY 未配置');
    return { code: 2, msg: 'NO_LLM_KEY', list: [] };
  }

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
    const spots = validate(extractJson(content), adcode).map((s) => {
      s._id = docId(s.adcode, s.name);
      return s;
    });
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
