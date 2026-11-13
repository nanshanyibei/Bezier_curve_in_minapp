/**
 * 把 5a-raw.txt（省|名称|年份）解析成结构化数据
 *
 * 输出：assets/data/attractions-5a.js
 * 紧凑格式（省体积）：[名称, 省adcode, 城市, 年份, lat, lng, 类型]
 * 坐标暂空，由 match-5a.js 用开源数据集回填。
 *
 * 用法：node scripts/data/parse-5a.js && node scripts/data/match-5a.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const RAW = path.join(__dirname, '5a-raw.txt');
const OUT = path.join(ROOT, 'assets/data/attractions-5a.js');

const PROV = {
  北京: 110000, 天津: 120000, 河北: 130000, 山西: 140000, 内蒙古: 150000,
  辽宁: 210000, 吉林: 220000, 黑龙江: 230000, 上海: 310000, 江苏: 320000,
  浙江: 330000, 安徽: 340000, 福建: 350000, 江西: 360000, 山东: 370000,
  河南: 410000, 湖北: 420000, 湖南: 430000, 广东: 440000, 广西: 450000,
  海南: 460000, 重庆: 500000, 四川: 510000, 贵州: 520000, 云南: 530000,
  西藏: 540000, 陕西: 610000, 甘肃: 620000, 青海: 630000, 宁夏: 640000,
  新疆: 650000, 兵团: 659000
};

/** 市级前缀：xx市 / xx州 / xx盟 / xx地区 / xx县 / xx区，允许 2-12 字 */
const CITY_RE = /^([\u4e00-\u9fa5]{2,12}?(?:自治州|地区|市|州|盟|县|区))(.+)$/;

/**
 * 从名称里剥离城市前缀，最多剥两层（如"黔南州荔波县樟江景区"）
 * 名称尾部的括号是跨省/别名说明，先摘掉再切，否则「旅游区」会被当成「区」后缀剥反。
 */
const SUFFIX_RE = /旅游度假区|生态旅游区|文化旅游区|风景名胜区|旅游景区|度假区|旅游区|风景区|游览区|景区/g;
/** 去掉所有通用后缀与标点后还剩几个字，用来判断这个名字是不是「还有实体内容」 */
function meaningful(s) {
  return String(s || '').replace(SUFFIX_RE, '').replace(/[（）()\s·•、.\-—－]/g, '').length >= 2;
}

function splitCity(rawName) {
  let note = '';
  let name = String(rawName || '').replace(/\s*[（(]([^()（）]*)[)）]\s*$/, (m, p) => { note = p; return ''; }).trim();

  // 括号在开头时括号里是名称主体，如「（白水洋·鸳鸯溪）旅游景区」
  const lead = name.match(/^[（(]([^()（）]+)[)）](.+)$/);
  if (lead) name = lead[1] + lead[2];
  if (!meaningful(name)) name = String(rawName || '').trim();

  let rest = name;
  let city = '';
  for (let i = 0; i < 2; i++) {
    const m = rest.match(CITY_RE);
    if (!m) break;
    // 剥完必须还剩实体内容，避免「古徽州文化旅游区」被当成 城市=古徽州
    if (!meaningful(m[2])) break;
    // 剥出来的必须是行政区名，不能是带景区后缀的名字
    if (/景区|旅游区|风景区|游览区|度假区|古镇|古城|博物院|博物馆/.test(m[1])) break;
    city = m[1];
    rest = m[2];
  }

  // 剥掉城市前缀后可能才露出前置括号，如「宁德市（白水洋·鸳鸯溪）旅游景区」
  const lead2 = rest.match(/^[（(]([^()（）]+)[)）](.+)$/);
  if (lead2) rest = lead2[1] + lead2[2];

  // 名称里没有城市前缀时，从括号说明里补（如「陕西省延安市·山西省临汾市」取末段）
  if (!city && note) {
    const parts = note.split(/[·•、,，\s]+/).filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i--) {
      const mm = parts[i].replace(/^[^省区]*?(省|自治区|特别行政区)/, '').match(/([\u4e00-\u9fa5]{2,8}市)/);
      if (mm) { city = mm[1]; break; }
    }
  }
  return { city, name: rest };
}

/** 直辖市没有市级前缀，列表里统一用省名当城市 */
const MUNICIPALITY = { 110000: '北京市', 120000: '天津市', 310000: '上海市', 500000: '重庆市' };
/** 名称本身不带城市（跨市景区 / 省直辖），手工补 */
const CITY_FIX = {
  '福建土楼（永定·南靖）旅游景区': '龙岩市',
  '沂蒙山旅游区': '临沂市',
  '神农架生态旅游区': '神农架林区',
  '青海湖风景区': '海北藏族自治州',
  '十师185团白沙湖景区': '阿勒泰地区',
  '北京（通州）大运河文化旅游景区': '北京市'
};

/** 按类型打标签（后续可人工校准，这里先粗分） */
function guessTags(name) {
  const rules = [
    [/古城|古镇|古村|故里|故居|陵|寺|庙|祠|宫|塔|楼|阁|城墙|石窟|造像|遗址|博物|纪念馆|书院|文庙/, '人文'],
    [/山|峰|峡|谷|湖|海|岛|湾|河|江|泉|溪|洞|瀑|林|草原|沙漠|湿地|梯田|丹霞|石林|滩|池|潭|冰川|雪/, '自然'],
    [/度假|游乐园|影视城|植物园|动物园|海洋|温泉|滑雪/, '休闲']
  ];
  const tags = [];
  rules.forEach(([re, tag]) => { if (re.test(name) && tags.indexOf(tag) < 0) tags.push(tag); });
  return tags.length ? tags : ['人文'];
}

const lines = fs.readFileSync(RAW, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
const seen = {};
const rows = [];
const dropped = [];

lines.forEach((line) => {
  const [provName, name, year] = line.split('|');
  const prov = PROV[provName];
  if (!prov || !name) { dropped.push(line); return; }

  // 跨省共挂的景区（壶口瀑布）只留一条，标记 multi
  const key = name.replace(/[（(].*?[)）]/g, '');
  if (seen[key]) {
    seen[key].multi = true;
    seen[key].provinces.push(prov);
    return;
  }

  const s = splitCity(name);
  if (!s.city) s.city = MUNICIPALITY[prov] || CITY_FIX[name] || CITY_FIX[s.name] || '';
  const row = {
    name: s.name,
    full: name,
    prov: prov,
    city: s.city,
    year: year || '',
    lat: 0,
    lng: 0,
    tags: guessTags(s.name),
    multi: false,
    provinces: [prov]
  };
  seen[key] = row;
  rows.push(row);
});

// 排序：省内按年份新→旧，同年前面先入列的在前
rows.sort((a, b) => (a.prov - b.prov) || (parseInt(b.year) - parseInt(a.year)));

const compact = rows.map((r) => [r.name, r.prov, r.city, r.year, r.lat, r.lng, r.tags.join(',')]);

const out = `/**
 * 国家 5A 级旅游景区 · 静态数据（文旅部名录，数据截止 2025-03）
 * 共 ${rows.length} 家，去除跨省重复登记（壶口瀑布）。
 * 紧凑数组：[名称, 省adcode, 城市, 评定年份, lat, lng, 类型]
 * 坐标由 scripts/data/match-5a.js 用开源 WGS84 数据集回填，0 表示未解析。
 */
module.exports = {
  v: 1,
  total: ${rows.length},
  list: ${JSON.stringify(compact)}
};
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out, 'utf8');

const byProv = {};
rows.forEach((r) => { byProv[r.prov] = (byProv[r.prov] || 0) + 1; });
const provName = {};
Object.keys(PROV).forEach((k) => { provName[PROV[k]] = k; });

console.log('解析行数:', lines.length, '| 入库:', rows.length, '| 丢弃:', dropped.length);
if (dropped.length) console.log('丢弃:', dropped);
console.log('文件大小:', (fs.statSync(OUT).size / 1024).toFixed(1) + ' KB');
console.log('省级分布:', Object.keys(byProv).map((p) => provName[p] + byProv[p]).join(' '));
console.log('河南样例:', rows.filter((r) => r.prov === 410000).map((r) => r.city + '|' + r.name).join(' / '));
console.log('未剥出城市的:', rows.filter((r) => !r.city).length);
