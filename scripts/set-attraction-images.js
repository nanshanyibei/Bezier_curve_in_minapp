/**
 * 主图回填：把 content/images/credits.json 里的授权图对应到内容源条目
 *
 * 用法：
 *   node scripts/set-attraction-images.js --prefix cloud://<env>.<bucket> --dry
 *   node scripts/set-attraction-images.js --prefix cloud://<env>.<bucket>
 *
 * 约定：图片上传到云存储的 attractions/<省adcode>/<文件名>，
 * 脚本按 prefix + '/attractions/<省adcode>/<文件名>' 生成 img(fileID)，
 * 同时写入 imgCredit（作者 / 许可证 / 来源页），满足授权署名要求。
 *
 * 上传前的本地图在 content/images/<省adcode>/ 下，长边 750、≤120KB。
 * 改完记得跑 node scripts/validate-details.js --bundle 重建导入文件。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'content', 'details');
const CREDITS = path.join(ROOT, 'content', 'images', 'credits.json');

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return '';
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : '';
}

const prefix = arg('prefix').replace(/\/+$/, '');
const dry = process.argv.indexOf('--dry') >= 0;

if (!prefix) {
  console.error('缺少 --prefix，例如：--prefix cloud://prod-xxx.7072-prod-xxx-1250000000');
  process.exit(1);
}
if (!fs.existsSync(CREDITS)) {
  console.error('没有 ' + path.relative(ROOT, CREDITS) + '，先跑抓图脚本');
  process.exit(1);
}

const credits = JSON.parse(fs.readFileSync(CREDITS, 'utf8'));
const byProv = {};
credits.forEach((c) => { (byProv[c.prov] || (byProv[c.prov] = [])).push(c); });

let hit = 0;
Object.keys(byProv).forEach((prov) => {
  const file = path.join(SRC_DIR, prov + '.json');
  if (!fs.existsSync(file)) return;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const map = {};
  byProv[prov].forEach((c) => { map[c.name] = c; });

  let changed = false;
  (data.spots || []).forEach((s) => {
    const c = s && map[s.name];
    if (!c) return;
    const base = path.basename(c.file);
    s.img = prefix + '/attractions/' + prov + '/' + base;
    s.imgCredit = c.author + ' / ' + c.license;
    s.imgSource = c.page;
    if (!s.src) s.src = {};
    s.src.img = 'manual';
    hit++;
    changed = true;
  });

  if (changed) {
    if (!dry) {
      data.updatedAt = Date.now();
      fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
    }
    console.log((dry ? '[dry] ' : '✓ ') + prov + '.json');
  }
});

console.log((dry ? '[dry] ' : '') + '回填 ' + hit + ' 条主图');
if (!dry) console.log('下一步：node scripts/validate-details.js --bundle');
