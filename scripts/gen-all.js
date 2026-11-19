/**
 * 批量生成各省景区内容草稿（离线工具，不进包、不参与运行时）
 *
 * 用法：
 *   SILICONFLOW_KEY=sk-xxx node scripts/gen-all.js --top 3 --per 6
 *   ... --prov 320000,330000      指定省份（逗号分隔）
 *   ... --top 5                   按家数从多到少取前 5 个省
 *   ... --per 6                   每省最多生成 6 家（0 或不填 = 全部补齐）
 *   ... --order adcode            改成按 adcode 升序
 *   ... --force                   已有内容的省也重跑（会补缺失的，不覆盖已有）
 *   ... --dry                     只打印计划，不真的调用
 *
 * 行为：
 *   - 串行调 gen-details.js --merge，单省失败不影响其它省
 *   - 每省结束打印进度，全部结束打印汇总和下一步命令
 *   - 断点续跑：已写过内容的景区不会再调 AI（gen-details 内部按 name 去重）
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { isDone } = require('./content-rules');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'content', 'details');
const BOOK = require('../assets/data/attractions-5a.js');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

function flag(name) {
  return process.argv.indexOf('--' + name) >= 0;
}

/** 省 adcode → 名录条目 */
function provIndex() {
  const m = {};
  BOOK.list.forEach((r) => {
    const p = String(r[1]).slice(0, 2) + '0000';
    (m[p] || (m[p] = [])).push({ name: String(r[0]), city: r[2] });
  });
  return m;
}

/** 该省未完成条目数（口径 = content-rules.isDone，与 gen-details / validate 一致） */
function doneOf(prov) {
  const done = {};
  [path.join(SRC_DIR, prov + '.json'), path.join(SRC_DIR, '.draft', prov + '.json')].forEach((f) => {
    if (!fs.existsSync(f)) return;
    try {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      (d.spots || []).forEach((s) => { if (s && s.name && isDone(s)) done[s.name] = true; });
    } catch (e) { /* 坏文件当没写过，脚本内部还会再校验 */ }
  });
  return done;
}

function run(prov, per) {
  return new Promise((resolve) => {
    const args = [path.join(__dirname, 'gen-details.js'), prov, '--merge'];
    if (per > 0) args.push('--limit', String(per));
    const cp = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
    cp.on('close', (code) => resolve(code === 0));
    cp.on('error', () => resolve(false));
  });
}

async function main() {
  const idx = provIndex();
  const only = String(arg('prov', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const order = String(arg('order', 'size'));
  const per = Number(arg('per', 0)) || 0;
  const top = Number(arg('top', 0)) || 0;
  const force = flag('force');
  const dry = flag('dry');

  let list = Object.keys(idx).map((p) => {
    const book = idx[p];
    const done = doneOf(p);
    const left = book.filter((s) => !done[s.name]);
    return { prov: p, total: book.length, left: left.length, names: book.slice(0, 2).map((s) => s.city).join('/') };
  });

  if (only.length) list = list.filter((r) => only.indexOf(r.prov) >= 0);
  if (!force) list = list.filter((r) => r.left > 0);
  list = list.sort((a, b) => (order === 'adcode' ? a.prov.localeCompare(b.prov) : b.total - a.total));
  if (top > 0) list = list.slice(0, top);

  if (!list.length) {
    console.log('没有需要处理的省（全部已有内容，或 --prov 没匹配上）。');
    return;
  }

  const totalLeft = list.reduce((n, r) => n + (per > 0 ? Math.min(per, r.left) : r.left), 0);
  console.log('计划：' + list.length + ' 个省，待写 ' + totalLeft + ' 家' + (per > 0 ? '（每省上限 ' + per + '）' : ''));
  list.forEach((r) => {
    console.log('  ' + r.prov + '  已有 ' + (r.total - r.left) + '/' + r.total + '  待写 ' + r.left);
  });

  if (dry) {
    console.log('\n--dry 模式，未调用 AI。去掉 --dry 开始生成。');
    return;
  }

  const fail = [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    console.log('\n===== [' + (i + 1) + '/' + list.length + '] ' + r.prov + ' =====');
    const ok = await run(r.prov, per);
    if (!ok) fail.push(r.prov);
  }

  console.log('\n===== 汇总 =====');
  console.log('成功 ' + (list.length - fail.length) + ' 个省' + (fail.length ? '，失败：' + fail.join(', ') : ''));
  console.log('下一步：');
  console.log('  node scripts/validate-details.js              校验全部，产出导入文件');
  console.log('  node scripts/preview-details.js               出评审页，人工过一遍');
  console.log('  node scripts/validate-details.js --bundle     合成单文件，一次导入云库');
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
