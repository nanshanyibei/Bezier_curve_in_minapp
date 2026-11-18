/**
 * 备份数据 → 微信云开发导入文件转换器
 *
 * 用法：node scripts/prep-import.js
 * 输入：backup/cloudbase-export-2026-11-17/*.json（pgdoc 导出）
 * 输出：backup/cloudbase-export-2026-11-17/import-ready/<collection>.json
 *       （JSON Lines，云开发控制台 → 数据库 → 集合 → 导入，冲突模式选 upsert）
 *
 * 处理规则：
 *   1. marks/diaries/chats 的 {_id, data:{...}} 嵌套拍平为单层文档；
 *   2. data.owner → _openid（新 appid 的 openid，映射表 openid-map.json 提供），原值留 owner_old 供审计；
 *   3. attractions 扁平结构原样导出（公开集合，无 _openid）；
 *   4. openid-map.json 缺失或映射不全时，私有集合不产出文件并提示——避免导入后数据认不回。
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'backup', 'cloudbase-export-2026-11-17');
const OUT = path.join(SRC, 'import-ready');
const PRIVATE_COLS = ['marks', 'diaries', 'chats'];

// 旧 openid → 新 openid 映射（拿到新号 openid 后在此填写，或改用命令行参数传入）
//   例：node scripts/prep-import.js oQb-a5YTqlhDG5iqO-FZb8yjV160=新的openid
const mapFile = path.join(SRC, 'openid-map.json');
let openidMap = {};
if (fs.existsSync(mapFile)) {
  openidMap = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
}
process.argv.slice(2).forEach((pair) => {
  const i = pair.indexOf('=');
  if (i > 0) openidMap[pair.slice(0, i)] = pair.slice(i + 1);
});

fs.mkdirSync(OUT, { recursive: true });

function load(col) {
  const j = JSON.parse(fs.readFileSync(path.join(SRC, col + '.json'), 'utf8'));
  return j.docs || [];
}

function flatten(d) {
  if (d.data && typeof d.data === 'object' && !Array.isArray(d.data)) {
    return Object.assign({ _id: d._id }, d.data);
  }
  return d;
}

const summary = [];

// 公开集合：直接导出
const attractions = load('attractions').map(flatten);
const attrFile = path.join(OUT, 'attractions.json');
fs.writeFileSync(attrFile, attractions.map((d) => JSON.stringify(d)).join('\n') + '\n');
summary.push({ col: 'attractions', total: attractions.length, written: attractions.length, skipped: 0 });

// 私有集合：按 owner 分批导入，已映射的先走，未映射的留待补充
PRIVATE_COLS.forEach((col) => {
  const docs = load(col).map(flatten);
  const owners = {};
  docs.forEach((d) => { owners[d.owner || ''] = (owners[d.owner || ''] || 0) + 1; });
  const missing = Object.keys(owners).filter((o) => o && !openidMap[o]);
  const rows = docs
    .filter((d) => d.owner && openidMap[d.owner])
    .map((d) => {
      const out = Object.assign({}, d);
      out._openid = openidMap[d.owner];
      out.owner_old = d.owner;
      delete out.owner;
      return out;
    });

  if (!rows.length) {
    console.warn(`[${col}] 无可导入文档，缺少 openid 映射。涉及 owner：`);
    missing.forEach((o) => console.warn(`  ${o}（${owners[o]} 条）`));
    summary.push({ col, total: docs.length, written: 0, skipped: docs.length, missingOwners: missing });
    return;
  }

  const f = path.join(OUT, col + '.json');
  fs.writeFileSync(f, rows.map((d) => JSON.stringify(d)).join('\n') + '\n');
  summary.push({ col, total: docs.length, written: rows.length, skipped: docs.length - rows.length, missingOwners: missing });
  if (missing.length) {
    console.warn(`[${col}] 部分导入（缺映射的 ${docs.length - rows.length} 条未写入）。待映射 owner：`);
    missing.forEach((o) => console.warn(`  ${o}（${owners[o]} 条）`));
  }
});

console.log('\n=== 转换结果 ===');
summary.forEach((s) => {
  console.log(`${s.col}: ${s.written}/${s.total} 条${s.skipped ? `（跳过 ${s.skipped}）` : ''} → import-ready/${s.col}.json`);
});
console.log('\n导入方法：微信开发者工具 → 云开发控制台 → 数据库 → 集合 → 导入 → 选对应 .json → 冲突模式 upsert');
