/**
 * 内容门禁：把 content/details/*.json 校验成可导入云数据库的文件
 *
 * 用法：
 *   node scripts/validate-details.js            # 校验全部省份，通过则产出导入文件
 *   node scripts/validate-details.js 110000     # 只校验某个省
 *   node scripts/validate-details.js --force    # 有 ERROR 也产出（仅调试，禁止用于发布）
 *
 * 输出：
 *   backup/wxcloud-import/attraction_details/p_<省adcode>.json  （JSON Lines，一条一个省文档）
 *
 * 规则见 docs/5a-content-architecture.md「内容门禁」一节。
 * 宁可缺字段，不要写空话：必填项缺失直接判错，可选字段缺了只是警告（页面自动不渲染该行）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'content', 'details');
const OUT_DIR = path.join(ROOT, 'backup', 'wxcloud-import', 'attraction_details');
const BOOK = require('../assets/data/attractions-5a.js');

/** 受控标签词表：只允许这些，避免标签爆炸 */
const VOCAB = [
  '世界遗产', '国家公园', '地质奇观', '山水', '古建', '宗教', '红色', '园林',
  '古镇', '民俗', '亲子', '摄影', '夜游', '索道', '温泉', '博物馆',
  '遗址', '历史', '美食', '冰雪', '演出'
];

/** 套话/绝对化用语：命中即判错 */
const BANNED = /秀丽|历史悠久|值得一游|必去|必来|第一|最美|驰名|闻名遐迩|人间仙境|美不胜收|不容错过|打卡圣地/;

const LIMITS = {
  oneline: { min: 8, max: 24 },
  intro: { min: 120, max: 240 },
  highlights: { min: 3, max: 5, itemMax: 30, itemMin: 8 },
  tags: { min: 3, max: 6 },
  bestMonths: 16,
  duration: 10,
  ticket: 24,
  hours: 24,
  transport: 60,
  tips: 60
};

const len = (s) => (typeof s === 'string' ? Array.from(s.trim()).length : 0);

function fail(list, where, msg) {
  list.push({ level: 'ERROR', where: where, msg: msg });
}

function warn(list, where, msg) {
  list.push({ level: 'WARN', where: where, msg: msg });
}

/** 名录索引：省 adcode → 该省景区名集合 */
function bookIndex() {
  const byProv = {};
  BOOK.list.forEach((r) => {
    const prov = String(r[1]).slice(0, 2) + '0000';
    (byProv[prov] || (byProv[prov] = [])).push(String(r[0]));
  });
  return byProv;
}

function checkSpot(spot, provName, out) {
  const where = provName + ' / ' + (spot.name || '(无名)');

  if (!spot || typeof spot !== 'object') { fail(out, provName, '条目不是对象'); return; }
  if (!spot.name) { fail(out, where, '缺 name'); return; }
  if (!BOOK_NAMES[spot.name]) { fail(out, where, 'name 不在名录里（必须与 attractions-5a.js 完全一致）'); return; }

  // 必填：oneline
  if (!spot.oneline) fail(out, where, '缺 oneline（一句话点题）');
  else {
    const n = len(spot.oneline);
    if (n < LIMITS.oneline.min || n > LIMITS.oneline.max) {
      fail(out, where, 'oneline 长度 ' + n + '，要求 ' + LIMITS.oneline.min + '~' + LIMITS.oneline.max);
    }
    if (/[。；]$/.test(spot.oneline)) warn(out, where, 'oneline 结尾不要句号/分号');
  }

  // 必填：tags
  if (!Array.isArray(spot.tags) || !spot.tags.length) fail(out, where, '缺 tags');
  else {
    if (spot.tags.length < LIMITS.tags.min || spot.tags.length > LIMITS.tags.max) {
      fail(out, where, 'tags 条数 ' + spot.tags.length + '，要求 ' + LIMITS.tags.min + '~' + LIMITS.tags.max);
    }
    spot.tags.forEach((t) => {
      if (VOCAB.indexOf(t) < 0) fail(out, where, '标签「' + t + '」不在受控词表内');
    });
  }

  // 必填：intro
  if (!spot.intro) fail(out, where, '缺 intro');
  else {
    const n = len(spot.intro);
    if (n < LIMITS.intro.min || n > LIMITS.intro.max) {
      fail(out, where, 'intro 长度 ' + n + '，要求 ' + LIMITS.intro.min + '~' + LIMITS.intro.max);
    }
  }

  // 必填：highlights
  if (!Array.isArray(spot.highlights) || !spot.highlights.length) fail(out, where, '缺 highlights');
  else {
    const hs = spot.highlights;
    if (hs.length < LIMITS.highlights.min || hs.length > LIMITS.highlights.max) {
      fail(out, where, 'highlights 条数 ' + hs.length + '，要求 ' + LIMITS.highlights.min + '~' + LIMITS.highlights.max);
    }
    hs.forEach((h, i) => {
      const n = len(h);
      if (n < LIMITS.highlights.itemMin) fail(out, where, 'highlights[' + i + '] 太短（' + n + ' 字），写具体一点');
      if (n > LIMITS.highlights.itemMax) fail(out, where, 'highlights[' + i + '] 超长（' + n + ' > ' + LIMITS.highlights.itemMax + '）');
    });
  }

  // 可选字段：只查长度，不查是否为空（空 = 页面不渲染该行）
  ['bestMonths', 'duration', 'ticket', 'hours', 'transport', 'tips'].forEach((k) => {
    if (spot[k] && len(spot[k]) > LIMITS[k]) {
      fail(out, where, k + ' 超长（' + len(spot[k]) + ' > ' + LIMITS[k] + '）');
    }
  });

  // 事实性字段：只允许人工来源
  const src = spot.src || {};
  ['ticket', 'hours'].forEach((k) => {
    if (spot[k] && src[k] === 'generated') {
      fail(out, where, k + ' 来自生成结果，必须人工核实后改写（src.' + k + ' = manual）');
    }
  });

  // 套话扫描：oneline / intro / highlights 全扫
  const texts = [spot.oneline || '', spot.intro || ''].concat(spot.highlights || []);
  texts.forEach((t) => {
    const m = BANNED.exec(t || '');
    if (m) fail(out, where, '命中套话/绝对化用语「' + m[0] + '」→ ' + String(t).slice(0, 20));
  });

  // 缺失提醒
  ['ticket', 'hours', 'bestMonths', 'duration', 'transport', 'tips'].forEach((k) => {
    if (!spot[k]) warn(out, where, '未填 ' + k + '（页面会自动隐藏该行）');
  });
}

const BOOK_NAMES = {};
BOOK.list.forEach((r) => { BOOK_NAMES[String(r[0])] = true; });

function checkProvince(file) {
  const out = [];
  const full = path.join(SRC_DIR, file);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (e) {
    fail(out, file, 'JSON 解析失败：' + e.message);
    return { out: out, data: null };
  }

  const prov = Number(data.prov);
  if (!prov) { fail(out, file, '缺 prov'); return { out: out, data: null }; }
  if (String(prov) !== path.basename(file, '.json')) {
    fail(out, file, 'prov 与文件名不一致（文件名应为 ' + prov + '.json）');
  }

  const inBook = BOOK_BY_PROV[String(prov)] || [];
  if (!inBook.length) fail(out, file, '名录里没有这个省（adcode ' + prov + '）');

  if (!Array.isArray(data.spots) || !data.spots.length) {
    fail(out, file, 'spots 为空');
    return { out: out, data: null };
  }

  const seen = {};
  const onelines = {};
  data.spots.forEach((s) => {
    if (s && s.name) {
      if (seen[s.name]) fail(out, file, '景区重复：' + s.name);
      seen[s.name] = true;
      if (s.oneline) onelines[s.oneline] = (onelines[s.oneline] || 0) + 1;
    }
    checkSpot(s, file, out);
  });

  Object.keys(onelines).forEach((k) => {
    if (onelines[k] > 1) fail(out, file, 'oneline 重复 ' + onelines[k] + ' 次：' + k);
  });

  // 覆盖面提示：名录有这个省但内容没写全，不算错
  const missing = inBook.filter((n) => !seen[n]);
  if (missing.length) {
    warn(out, file, '该省还有 ' + missing.length + ' 家没写内容（共 ' + inBook.length + ' 家）');
  }

  return { out: out, data: data };
}

const BOOK_BY_PROV = bookIndex();

function main() {
  const args = process.argv.slice(2);
  const force = args.indexOf('--force') >= 0;
  const only = args.filter((a) => /^\d{6}$/.test(a));

  if (!fs.existsSync(SRC_DIR)) {
    console.error('没有内容源目录：' + SRC_DIR);
    process.exit(1);
  }

  const files = fs.readdirSync(SRC_DIR)
    .filter((f) => f.endsWith('.json'))
    .filter((f) => !only.length || only.indexOf(path.basename(f, '.json')) >= 0)
    .sort();

  if (!files.length) {
    console.error('没有待校验的文件');
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  let errCount = 0;
  let warnCount = 0;
  const written = [];

  files.forEach((file) => {
    const r = checkProvince(file);
    const errs = r.out.filter((x) => x.level === 'ERROR');
    const warns = r.out.filter((x) => x.level === 'WARN');
    errCount += errs.length;
    warnCount += warns.length;

    console.log('');
    console.log('── ' + file + ' ── ' + (r.data ? r.data.spots.length + ' 条' : '解析失败'));
    errs.forEach((x) => console.log('  ✗ ' + (x.where !== file ? x.where + ' → ' : '') + x.msg));
    warns.slice(0, 8).forEach((x) => console.log('  · ' + (x.where !== file ? x.where + ' → ' : '') + x.msg));
    if (warns.length > 8) console.log('  · 其余 ' + (warns.length - 8) + ' 条提醒略');

    if (errs.length && !force) {
      console.log('  → 未产出导入文件（先修掉 ✗）');
      return;
    }
    if (!r.data) return;

    const doc = {
      _id: 'p_' + String(r.data.prov).slice(0, 2) + '0000',
      prov: Number(r.data.prov),
      v: r.data.v || 1,
      publishedAt: r.data.updatedAt || Date.now(),
      spots: r.data.spots
    };
    const outFile = path.join(OUT_DIR, doc._id + '.json');
    fs.writeFileSync(outFile, JSON.stringify(doc) + '\n', 'utf8');
    written.push({ file: path.relative(ROOT, outFile), size: fs.statSync(outFile).size });
    console.log('  ✓ 产出 ' + path.relative(ROOT, outFile) + '（' + (fs.statSync(outFile).size / 1024).toFixed(1) + ' KB）');
  });

  console.log('');
  console.log('汇总：ERROR ' + errCount + ' · WARN ' + warnCount + ' · 产出 ' + written.length + ' 个文件');
  if (!written.length) {
    console.log('没有任何文件产出。');
    process.exit(errCount ? 1 : 0);
  }
  console.log('导入：微信云开发控制台 → 数据库 → 集合 attraction_details → 导入（冲突模式 upsert）');
  if (errCount) {
    console.log('注意：存在 ERROR，当前产出仅可用于调试，不可发布。');
    process.exit(1);
  }
}

main();
