/**
 * 内容草稿生成（离线工具，不参与小程序运行，也不进包）
 *
 * 用法：
 *   SILICONFLOW_KEY=sk-xxx node scripts/gen-details.js 110000
 *   ... --limit 5      只补前 5 家（先小批量试水）
 *   ... --batch 4      每次请求写 4 家（默认 4，太多会截断）
 *   ... --dry          只打印提示词，不请求
 *   ... --merge        草稿直接并入 content/details/<prov>.json（生成条目标 src.intro=generated，需人工复核）
 *
 * 换模型/换服务商（任何 OpenAI 兼容端点都行）：
 *   CONTENT_BASE=https://api.deepseek.com/v1 CONTENT_KEY=sk-xxx \
 *   CONTENT_MODEL=deepseek-chat node scripts/gen-details.js 320000
 *   CONTENT_BASE=https://dashscope.aliyuncs.com/compatible-mode/v1 \
 *   CONTENT_MODEL=qwen-plus CONTENT_KEY=sk-xxx node scripts/gen-details.js 320000
 *
 * 设计约束（和 docs/5a-content-architecture.md 对齐）：
 *   1. 只允许生成 6 个字段，门票/开放时间/交通一律不采信——这些是会变且会坑人的事实；
 *   2. 已有人工内容的景区不会被覆盖；
 *   3. 生成结果只是草稿，必须过 validate-details.js 门禁 + 人工评审才能发布。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { isDone, len } = require('./content-rules');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'content', 'details');
const DRAFT_DIR = path.join(SRC_DIR, '.draft');
const BOOK = require('../assets/data/attractions-5a.js');

const MODEL = process.env.CONTENT_MODEL || 'deepseek-ai/DeepSeek-V4-Flash';
const BASE = (process.env.CONTENT_BASE || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '');
const ENDPOINT = BASE + '/chat/completions';
const KEY = process.env.SILICONFLOW_KEY || process.env.CONTENT_KEY || '';

const VOCAB = [
  '世界遗产', '国家公园', '地质奇观', '山水', '古建', '宗教', '红色', '园林',
  '古镇', '民俗', '亲子', '摄影', '夜游', '索道', '温泉', '博物馆',
  '遗址', '历史', '美食', '冰雪', '演出'
];

const FIELDS = ['name', 'oneline', 'tags', 'intro', 'highlights', 'bestMonths', 'duration'];

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

function bookOf(prov) {
  return BOOK.list
    .filter((r) => String(r[1]).slice(0, 2) + '0000' === String(prov))
    .map((r) => ({ name: r[0], city: r[2], year: r[3], type: r[6] }));
}

function readProv(prov) {
  const f = path.join(SRC_DIR, prov + '.json');
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

function buildPrompt(batch) {
  const lines = batch.map((s, i) => (
    (i + 1) + '. ' + s.name + '（' + s.city + '，' + s.year + ' 年评定，' + s.type + '）'
  )).join('\n');

  return [
    '你是中文旅行内容编辑。为下列景区各写一条条目，只输出 JSON 数组，不要解释、不要代码块围栏。',
    '',
    '字段（只能这 ' + FIELDS.length + ' 个，多写的一律丢弃）：',
    'name：原样使用我给的全称，一个字都不能改',
    'oneline：8~24 字，一句具体的话说清它是什么，不用形容词堆砌',
    'tags：3~6 个，只能从下列词表选：' + VOCAB.join('、'),
    'intro：150~240 字。写地理位置、年代或规模、核心价值（世界遗产/地质/历史）、一句话体验。只写可核实的事实，不确定的数字宁可不写。低于 150 字会被门禁拒绝。',
    'highlights：3~5 条，每条 8~30 字。必须落到「看什么、在哪个位置、什么时候最好」，不要「风景优美」这类空话。',
    'bestMonths：不超过 16 字',
    'duration：不超过 10 字（如「半天」「2-3 小时」）',
    '',
    '严禁输出：门票价格、开放时间、交通方式、电话、官网等易变信息。',
    '严禁使用：秀丽、历史悠久、值得一游、必去、最美、驰名、闻名遐迩、人间仙境、美不胜收、不容错过。任何评价值得用的最高级一律不写；唯一例外是景区官方名号或史实原文（如「天下第一关」城楼、「天下第一泉」、「中国第一条标准轨距铁路」），必须原样保留。',
    '',
    '景区列表：',
    lines,
    '',
    '输出格式：[{"name":"...","oneline":"...","tags":["..."],"intro":"...","highlights":["..."],"bestMonths":"...","duration":"..."}]'
  ].join('\n');
}

function request(prompt) {
  const body = JSON.stringify({
    model: MODEL,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
    max_tokens: 2400
  });

  return new Promise((resolve, reject) => {
    const req = https.request(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + KEY,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 90000
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error('HTTP ' + res.statusCode + '：' + raw.slice(0, 200)));
          return;
        }
        try {
          resolve(JSON.parse(raw).choices[0].message.content);
        } catch (e) {
          reject(new Error('响应解析失败'));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.write(body);
    req.end();
  });
}

function extractJson(text) {
  const a = text.indexOf('[');
  const b = text.lastIndexOf(']');
  if (a < 0 || b <= a) throw new Error('响应里没有 JSON 数组');
  return JSON.parse(text.slice(a, b + 1));
}

/** 白名单裁剪 + 基本长度检查；不合格的直接丢，不写入草稿 */
function clean(item, allowed) {
  if (!item || !allowed[item.name]) return null;
  const out = {
    name: item.name,
    oneline: String(item.oneline || '').trim().slice(0, 24),
    tags: (Array.isArray(item.tags) ? item.tags : [])
      .filter((t) => VOCAB.indexOf(t) >= 0).slice(0, 6),
    intro: String(item.intro || '').trim().slice(0, 240),
    highlights: (Array.isArray(item.highlights) ? item.highlights : [])
      .map((h) => String(h).trim()).filter((h) => len(h) >= 6 && len(h) <= 30).slice(0, 5),
    bestMonths: String(item.bestMonths || '').trim().slice(0, 16),
    duration: String(item.duration || '').trim().slice(0, 10),
    ticket: '',
    hours: '',
    transport: '',
    tips: '',
    src: { intro: 'generated', highlights: 'generated', oneline: 'generated' }
  };
  if (len(out.oneline) < 8 || len(out.intro) < 120 || out.tags.length < 3 || out.highlights.length < 3) return null;
  return out;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const prov = process.argv.slice(2).filter((a) => /^\d{6}$/.test(a))[0];
  if (!prov) {
    console.error('用法：node scripts/gen-details.js <省adcode> [--limit n] [--batch n] [--dry] [--merge]');
    process.exit(1);
  }

  const book = bookOf(prov);
  if (!book.length) {
    console.error('名录里没有这个省：' + prov);
    process.exit(1);
  }

  const exist = readProv(prov);
  const done = {};
  // 「已完成」口径与 gen-all / validate 一致（content-rules.isDone）：
  // 人工内容永不重写；AI 条目 intro ≥120 且无套话才算完成，否则重跑时自动补写
  (exist && exist.spots ? exist.spots : []).forEach((s) => { done[s.name] = isDone(s); });
  const todo = book.filter((s) => !done[s.name]);

  const limit = Number(arg('limit', 0)) || todo.length;
  const batchSize = Number(arg('batch', 4)) || 4;
  const targets = todo.slice(0, limit);

  console.log('省份 ' + prov + '：名录 ' + book.length + ' 家，已有 ' + Object.keys(done).length + ' 家，本次待写 ' + targets.length + ' 家');

  if (!targets.length) {
    console.log('没有需要补的，收工。');
    return;
  }

  if (arg('dry', false)) {
    console.log('\n--- 提示词预览 ---\n');
    console.log(buildPrompt(targets.slice(0, batchSize)));
    return;
  }

  if (!KEY) {
    console.error('缺 API key。用 SILICONFLOW_KEY 或 CONTENT_KEY 传，例如：');
    console.error('  SILICONFLOW_KEY=sk-xxx node scripts/gen-details.js ' + prov);
    console.error('  CONTENT_BASE=https://api.deepseek.com/v1 CONTENT_KEY=sk-xxx CONTENT_MODEL=deepseek-chat node scripts/gen-details.js ' + prov);
    process.exit(1);
  }

  const got = [];
  for (let i = 0; i < targets.length; i += batchSize) {
    const batch = targets.slice(i, i + batchSize);
    const allowed = {};
    batch.forEach((s) => { allowed[s.name] = true; });
    process.stdout.write('· 第 ' + (i / batchSize + 1) + ' 批（' + batch.length + ' 家）… ');
    try {
      const text = await request(buildPrompt(batch));
      const arr = extractJson(text);
      let n = 0;
      arr.forEach((it) => {
        const c = clean(it, allowed);
        if (c) { got.push(c); n++; }
      });
      console.log('入库 ' + n + ' 条');
    } catch (e) {
      console.log('失败：' + e.message);
    }
    if (i + batchSize < targets.length) await sleep(1200);
  }

  if (!got.length) {
    console.error('一条都没生成成功，检查 key / 网络 / 模型名。');
    process.exit(1);
  }

  const payload = {
    prov: Number(prov),
    v: (exist && exist.v) || 1,
    updatedAt: Date.now(),
    note: '草稿：src 标 generated 的条目未经人工复核，勿直接发布',
    spots: got
  };

  if (arg('merge', false)) {
    // 同名替换：本次生成的覆盖旧的（用于补写 intro 过短的条目）；
    // 旧条目里 src.intro=manual 的人工内容若同名被覆盖了也说明 AI 不该碰它——但 done 判断已保证 manual 不会进 targets
    const gotNames = {};
    got.forEach((s) => { gotNames[s.name] = true; });
    const kept = (exist && exist.spots ? exist.spots : []).filter((s) => !(s && s.name && gotNames[s.name]));
    const merged = {
      prov: Number(prov),
      v: (exist && exist.v) || 1,
      updatedAt: Date.now(),
      spots: kept.concat(got)
    };
    fs.mkdirSync(SRC_DIR, { recursive: true });
    fs.writeFileSync(path.join(SRC_DIR, prov + '.json'), JSON.stringify(merged, null, 2) + '\n', 'utf8');
    console.log('\n已并入 content/details/' + prov + '.json（共 ' + merged.spots.length + ' 条，替换 ' + Object.keys(gotNames).length + ' 条）');
  } else {
    fs.mkdirSync(DRAFT_DIR, { recursive: true });
    const out = path.join(DRAFT_DIR, prov + '.json');
    fs.writeFileSync(out, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    console.log('\n草稿已写到 ' + path.relative(ROOT, out) + '（' + got.length + ' 条）');
  }

  console.log('下一步：node scripts/validate-details.js ' + prov + '  →  node scripts/preview-details.js ' + prov + '  → 人工复核 → 导入云库');
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
