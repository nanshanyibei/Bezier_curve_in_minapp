/**
 * 内容评审页：把 content/details/<prov>.json 渲染成静态 HTML，按详情页样式排版
 *
 * 用法：
 *   node scripts/preview-details.js            # 全部省份
 *   node scripts/preview-details.js 110000     # 只出某个省
 *
 * 输出：content/preview/p_<省adcode>.html（直接双击用浏览器看）
 * 目的：人工过一遍内容比看 JSON 快得多，缺字段的地方会标黄。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'content', 'details');
const OUT_DIR = path.join(ROOT, 'content', 'preview');
const BOOK = require('../assets/data/attractions-5a.js');

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

function bookOf(prov) {
  return BOOK.list
    .filter((r) => String(r[1]).slice(0, 2) + '0000' === String(prov))
    .map((r) => ({ name: r[0], city: r[2], year: r[3], type: r[6] }));
}

function cityOf(prov, name) {
  const hit = bookOf(prov).filter((b) => b.name === name)[0];
  return hit ? hit.city : '';
}

function renderSpot(prov, s) {
  const miss = (v) => (!v ? '<span class="miss">未填</span>' : esc(v));
  const rows = [
    ['门票', s.ticket],
    ['开放', s.hours],
    ['最佳', s.bestMonths],
    ['建议', s.duration],
    ['到达', s.transport]
  ].filter((r) => r[1] || true).map((r) => (
    '<div class="row"><span class="k">' + r[0] + '</span><span class="v">' + miss(r[1]) + '</span></div>'
  )).join('');

  const tags = (s.tags || []).map((t) => '<span class="tag">' + esc(t) + '</span>').join('');
  const hs = (s.highlights || []).map((h, i) => (
    '<li><i>' + (i + 1) + '</i><span>' + esc(h) + '</span></li>'
  )).join('');

  return [
    '<section class="spot">',
    '  <div class="hero ' + (/自然/.test(s.tags || '') ? 'nature' : 'culture') + '">' + esc(String(s.name).slice(0, 1)) + '</div>',
    '  <div class="head">',
    '    <h2>' + esc(s.name) + ' <em>5A</em></h2>',
    '    <p class="meta">' + esc(cityOf(prov, s.name)) + '</p>',
    '    <p class="oneline">' + miss(s.oneline) + '</p>',
    '  </div>',
    '  <div class="tags">' + tags + '</div>',
    '  <div class="card"><h3>看点</h3><ol>' + hs + '</ol></div>',
    '  <div class="card"><h3>简介</h3><p class="intro">' + miss(s.intro) + '</p></div>',
    '  <div class="card"><h3>实用信息</h3>' + rows + '</div>',
    s.tips ? '  <div class="card tip"><h3>提醒</h3><p>' + esc(s.tips) + '</p></div>' : '  <div class="card tip"><h3>提醒</h3><p class="miss">未填</p></div>',
    '</section>'
  ].join('\n');
}

function page(prov, data) {
  const book = bookOf(prov);
  const names = {};
  data.spots.forEach((s) => { names[s.name] = true; });
  const missing = book.filter((b) => !names[b.name]);

  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>内容评审 · ' + prov + '</title>',
    '<style>',
    ':root{--bg:#16161c;--card:#1e1e24;--card2:#26262e;--bd:#33333d;--tx:#e8e8ee;--dim:#8b8b96;--ac:#6ea8fe;--or:#f0b35e;--gr:#7ed491}',
    '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.7 -apple-system,"PingFang SC",sans-serif}',
    'header{padding:20px 24px;border-bottom:1px solid var(--bd);position:sticky;top:0;background:var(--bg);z-index:2}',
    'header h1{margin:0 0 6px;font-size:18px}header p{margin:0;color:var(--dim);font-size:13px}',
    '.miss{color:var(--or);background:rgba(240,179,94,.12);padding:1px 6px;border-radius:4px;font-size:12px}',
    '.grid{max-width:760px;margin:0 auto;padding:16px}',
    '.spot{background:var(--card);border:1px solid var(--bd);border-radius:12px;margin-bottom:18px;overflow:hidden}',
    '.hero{height:110px;display:flex;align-items:center;justify-content:center;font-size:52px;font-weight:700;color:rgba(255,255,255,.18)}',
    '.hero.nature{background:linear-gradient(150deg,#1d3b33,#24504a 45%,#16161c)}',
    '.hero.culture{background:linear-gradient(150deg,#33283f,#4a3355 45%,#16161c)}',
    '.head{padding:16px 20px 0}.head h2{margin:0;font-size:20px}.head h2 em{font-style:normal;font-size:11px;background:var(--or);color:#16161c;padding:2px 6px;border-radius:4px;vertical-align:middle}',
    '.meta{margin:6px 0 0;color:var(--dim);font-size:13px}',
    '.oneline{margin:10px 0 0;color:var(--ac);font-size:15px}',
    '.tags{padding:12px 20px 0;display:flex;flex-wrap:wrap;gap:8px}',
    '.tag{font-size:12px;color:var(--ac);background:rgba(110,168,254,.14);padding:3px 10px;border-radius:999px}',
    '.card{margin:14px 20px;padding:14px 16px;background:var(--card2);border-radius:10px}',
    '.card h3{margin:0 0 8px;font-size:13px;color:var(--dim);font-weight:600}',
    '.card ol{margin:0;padding:0;list-style:none}.card li{display:flex;gap:10px;padding:4px 0}',
    '.card li i{flex:none;width:20px;height:20px;margin-top:3px;border-radius:50%;background:#2f2f3a;color:var(--ac);font-size:11px;font-style:normal;text-align:center;line-height:20px}',
    '.intro{margin:0}.row{display:flex;gap:14px;padding:5px 0;border-bottom:1px solid var(--bd)}.row:last-child{border:0}',
    '.row .k{flex:none;width:44px;color:var(--dim);font-size:13px}.row .v{flex:1}',
    '.tip{border:1px solid rgba(240,179,94,.28);background:rgba(240,179,94,.06)}',
    '.gap{max-width:760px;margin:0 auto 24px;padding:14px 18px;border:1px dashed var(--bd);border-radius:10px;color:var(--dim);font-size:13px}',
    '</style></head><body>',
    '<header><h1>内容评审 · 省级 adcode ' + prov + '</h1>',
    '<p>共 ' + data.spots.length + ' 条 · 名录 ' + book.length + ' 家 · 未覆盖 ' + missing.length + ' 家 · 版本 v' + (data.v || 1) + '</p></header>',
    '<div class="grid">',
    data.spots.map((s) => renderSpot(prov, s)).join('\n'),
    '</div>',
    missing.length ? '<div class="gap">未覆盖：' + missing.map((b) => esc(b.name)).join('、') + '</div>' : '',
    '</body></html>'
  ].join('\n');
}

function main() {
  const only = process.argv.slice(2).filter((a) => /^\d{6}$/.test(a));
  if (!fs.existsSync(SRC_DIR)) {
    console.error('没有内容源目录：' + SRC_DIR);
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const files = fs.readdirSync(SRC_DIR)
    .filter((f) => f.endsWith('.json'))
    .filter((f) => !only.length || only.indexOf(path.basename(f, '.json')) >= 0);

  if (!files.length) {
    console.error('没有可预览的文件');
    process.exit(1);
  }

  files.forEach((f) => {
    const data = JSON.parse(fs.readFileSync(path.join(SRC_DIR, f), 'utf8'));
    const out = path.join(OUT_DIR, 'p_' + String(data.prov) + '.html');
    fs.writeFileSync(out, page(data.prov, data), 'utf8');
    console.log('✓ ' + path.relative(ROOT, out) + '（' + data.spots.length + ' 条）');
  });
}

main();
