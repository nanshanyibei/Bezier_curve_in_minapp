/**
 * 云函数 genAttraction：按需生成景点推荐
 * 入参：{ adcode, name, parent? }
 * 流程：硅基流动 LLM 生成 5 条 → JSON 校验 → 写 attractions 集合（source: 'llm'）→ 返回列表
 * 环境变量（云函数控制台配置）：SILICONFLOW_KEY（必填）、SILICONFLOW_MODEL（可选）
 */
const cloudbase = require('@cloudbase/node-sdk');

const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });
const db = app.database();

const LLM_BASE = 'https://api.siliconflow.cn/v1/chat/completions';
const MODEL = process.env.SILICONFLOW_MODEL || 'deepseek-ai/DeepSeek-V3-0324';

function callLLM(prompt) {
  const key = process.env.SILICONFLOW_KEY;
  if (!key) return Promise.reject(new Error('未配置环境变量 SILICONFLOW_KEY'));
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

exports.main = async (event) => {
  const { adcode, name, parent } = event || {};
  if (!adcode || !name) return { code: 1, msg: '缺少 adcode/name' };

  const scope = parent ? parent + name : name;
  const prompt = '你是旅行顾问。请推荐 ' + scope + '（行政区划代码 ' + adcode + '）最有代表性的 5 个景点或体验，'
    + '每个包含字段：name（名称，不超过15字）、desc（一句话亮点介绍，不超过60字，突出特色，不要套话）、'
    + 'bestMonths（最适合游玩的月份，格式如 "4-6,9-10"，全年皆宜写 "四季皆宜"）、'
    + 'tags（1-3个标签，从 自然/人文/美食/夜景观赏/亲子/徒步/海岛/古镇/冰雪/温泉 中选）。'
    + '只输出 JSON 数组，不要任何其他文字。';

  try {
    const content = await callLLM(prompt);
    const spots = validate(extractJson(content), adcode);
    if (!spots.length) return { code: 1, msg: '生成结果校验后为空' };
    // 去重：集合里已有的名字不重复写
    const exist = await db.collection('attractions')
      .where({ adcode: String(adcode) }).limit(100).get();
    const have = {};
    (exist.data || []).forEach((d) => { have[d.name] = 1; });
    const fresh = spots.filter((s) => !have[s.name]);
    if (fresh.length) {
      await db.collection('attractions').add(fresh.map((s) => ({ data: s })));
    }
    // 返回全量视图：库里已有的 + 本次新生成的（客户端以此覆盖缓存）
    const list = await db.collection('attractions')
      .where({ adcode: String(adcode) }).limit(6).get();
    return { code: 0, list: (list.data || []).map((d) => ({
      name: d.name, desc: d.desc, img: d.img || '',
      bestMonths: d.bestMonths || '', tags: d.tags || []
    })) };
  } catch (e) {
    console.error('[genAttraction]', e.message);
    return { code: 1, msg: e.message };
  }
};
