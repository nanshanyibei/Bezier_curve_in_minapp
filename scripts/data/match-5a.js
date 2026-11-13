/**
 * 把开源 5A 数据集的 WGS84 坐标回填到我们的名录里
 *
 * 输入：scripts/data/china-5a-scenic-areas.json（上游 tuansuwu/china-5a-scenic-areas，CC BY-SA 4.0）
 *       assets/data/attractions-5a.js（parse-5a.js 产出）
 * 输出：回填坐标后的 attractions-5a.js + 可疑清单
 *
 * 匹配顺序：人工表 → 省内精确 → 省内别名 → 省内包含
 * 一律只在「本省」池里找，不做跨省同名兜底（否则烟台南山会串到三亚南山）。
 * 命中后再用省界多边形验一次点是否落在本省，偏出省界超过阈值的直接判废。
 *
 * 用法：node scripts/data/match-5a.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(__dirname, 'china-5a-scenic-areas.json');
const TARGET = path.join(ROOT, 'assets/data/attractions-5a.js');
const GEO = path.join(ROOT, 'subpackages/geo/china-full.js');

/** 名称归一化：循环剥括号、去通用后缀、删所有标点空格（含半角横线） */
function norm(s) {
  let t = String(s || '');
  let prev;
  do {
    prev = t;
    t = t.replace(/[（(][^()（）]*[)）]/g, '');
  } while (t !== prev);
  return t
    .replace(/旅游度假区|生态旅游区|文化旅游区|风景名胜区|旅游景区|度假区|旅游区|风景区|游览区|景区/g, '')
    .replace(/[－—–~·•・、.．,，:：\-\s'"“”‘’]/g, '')
    .trim();
}
/** 比较键：再去掉行政区后缀「市」 */
function keyOf(s) {
  return norm(s).replace(/市/g, '');
}

/** 归一化名对不上时的别名（我方 → 上游），键值均为 keyOf 的结果 */
const ALIAS = {
  阿斯哈图石林: '哈斯哈图石阵',
  伪满皇宫博物馆: '伪满皇宫博物院',
  福建土楼: '土楼永定',
  明故城三孔: '曲阜明故城',
  西峡恐龙遗迹园伏牛山老界岭: '伏牛山老界岭恐龙遗址园',
  神农溪纤夫文化: '神龙溪纤夫文化',
  神农溪纤夫: '神龙溪纤夫',
  独秀峰靖江王城: '独秀峰王城',
  黄果树瀑布: '黄果树大瀑布',
  普达措国家公园: '香格里拉普达措',
  中科院西双版纳热带植物园: '中国科学院西双版纳热带植物园',
  法门文化: '法门寺佛文化',
  华清宫: '华清池',
  秦始皇帝陵博物院: '秦始皇兵马俑博物馆',
  喀什古城: '喀什噶尔老城'
};

/**
 * 人工坐标（WGS84），优先级最高。
 * 两类用途：① 上游数据集缺条目；② 上游条目的坐标本身标错，实测/官方位置纠偏。
 */
const MANUAL = {
  // 上游未收录（2019 摘牌、2024 恢复 5A）
  乔家大院: [37.40607, 112.42998],
  // 上游把万佛湖标到了 114.76E（河南信阳一带），实际在安徽舒城
  万佛湖: [31.30361, 116.96611],
  // 上游把武陵山大裂谷标到了 108.74E（贵州境内），实际在重庆涪陵
  武陵山大裂谷: [29.63306, 107.80028],
  // 上游把八泉峡标到了 113.93E/36.99N（左权一带），实际在长治壶关
  太行山大峡谷八泉峡: [36.02917, 113.54583],
  // 上游把天山天池标到了 80.12E（阿克苏温宿境内），实际在昌吉阜康
  天山天池: [43.88389, 88.13389]
};

const PROV_CODE = {
  北京市: 110000, 天津市: 120000, 河北省: 130000, 山西省: 140000, 内蒙古自治区: 150000,
  辽宁省: 210000, 吉林省: 220000, 黑龙江省: 230000, 上海市: 310000, 江苏省: 320000,
  浙江省: 330000, 安徽省: 340000, 福建省: 350000, 江西省: 360000, 山东省: 370000,
  河南省: 410000, 湖北省: 420000, 湖南省: 430000, 广东省: 440000, 广西壮族自治区: 450000,
  海南省: 460000, 重庆市: 500000, 四川省: 510000, 贵州省: 520000, 云南省: 530000,
  西藏自治区: 540000, 陕西省: 610000, 甘肃省: 620000, 青海省: 630000, 宁夏回族自治区: 640000,
  新疆维吾尔自治区: 650000
};
/** 兵团在地图归属新疆，匹配坐标时按新疆找 */
const MATCH_PROV = { 659000: 650000 };

/* ---------- 省界校验 ---------- */

const geojson = require(GEO);
/** 统一成 MultiPolygon 结构：内蒙古/重庆等少数省级是 Polygon */
function toMulti(geom) {
  if (!geom || !geom.coordinates) return [];
  return geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
}
const GEOM = {};
geojson.features.forEach((f) => { GEOM[f.properties.adcode] = toMulti(f.geometry); });

function inRing(x, y, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
/** 点到线段距离（单位：度，够用） */
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}
/** 返回 {inside, dist}：dist 为到省界最近边的距离（度） */
function locate(lng, lat, adcode) {
  const rings = GEOM[adcode];
  if (!rings) return { inside: false, dist: 0, noGeom: true };
  let inside = false;
  let dist = Infinity;
  for (let p = 0; p < rings.length; p++) {
    const poly = rings[p];
    if (inRing(lng, lat, poly[0])) {
      let inHole = false;
      for (let h = 1; h < poly.length; h++) if (inRing(lng, lat, poly[h])) inHole = true;
      if (!inHole) inside = true;
    }
    for (let h = 0; h < poly.length; h++) {
      const ring = poly[h];
      for (let i = 1; i < ring.length; i++) {
        const d = distToSeg(lng, lat, ring[i - 1][0], ring[i - 1][1], ring[i][0], ring[i][1]);
        if (d < dist) dist = d;
      }
    }
  }
  return { inside, dist };
}

/** 允许偏出省界的距离：省界做过抽稀，海岛/边界景区会溢出去，0.22° ≈ 24km */
const TOLERANCE = 0.22;

/* ---------- 匹配 ---------- */

const src = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const mod = require(TARGET);
const rows = mod.list.map((r) => ({ name: r[0], prov: r[1], city: r[2], year: r[3], lat: r[4], lng: r[5], tags: r[6] }));

const byKeyProv = {};
const byProvPool = {};
src.forEach((s) => {
  if (!s.latitude || !s.longitude) return;
  const k = keyOf(s.name_zh);
  if (!k) return;
  const p = PROV_CODE[s.province_zh] || 0;
  if (!p) return;
  if (!byKeyProv[k + '|' + p]) byKeyProv[k + '|' + p] = s;
  (byProvPool[p] || (byProvPool[p] = [])).push(s);
});

const stat = { manual: 0, exact: 0, alias: 0, fuzzy: 0 };
const still = [];
const rejected = [];

rows.forEach((r) => {
  const p = MATCH_PROV[r.prov] || r.prov;
  const k = keyOf(r.name);
  const ak = ALIAS[k];

  const take = (cand, how) => {
    const lat = +(+cand.latitude).toFixed(6);
    const lng = +(+cand.longitude).toFixed(6);
    const loc = locate(lng, lat, p);
    if (loc.noGeom || loc.inside || loc.dist <= TOLERANCE) {
      r.lat = lat; r.lng = lng;
      stat[how]++;
      return true;
    }
    rejected.push({ name: r.name, prov: r.prov, city: r.city, lat, lng, dist: loc.dist, upstream: cand.name_zh });
    return false;
  };

  const mk = MANUAL[k];
  if (mk) {
    r.lat = mk[0]; r.lng = mk[1];
    stat.manual++;
    return;
  }
  if (!k) { still.push({ name: r.name, prov: r.prov, city: r.city, reason: '名称为空' }); return; }

  const exact = byKeyProv[k + '|' + p];
  if (exact && take(exact, 'exact')) return;

  const alias = ak && byKeyProv[ak + '|' + p];
  if (alias && take(alias, 'alias')) return;

  // 同省内做包含匹配，取名称较长（更具体）的那个
  const pool = byProvPool[p] || [];
  let best = null;
  pool.forEach((s) => {
    const sk = keyOf(s.name_zh);
    if (!sk || sk === k) return;
    if (sk.indexOf(k) >= 0 || k.indexOf(sk) >= 0) {
      if (!best || sk.length > keyOf(best.name_zh).length) best = s;
    }
  });
  if (best && take(best, 'fuzzy')) return;

  still.push({ name: r.name, prov: r.prov, city: r.city, reason: '省内无同名' });
});

const compact = rows.map((r) => [r.name, r.prov, r.city, r.year, r.lat, r.lng, r.tags]);
const geo = rows.filter((r) => r.lat).length;

const out = `/**
 * 国家 5A 级旅游景区 · 静态数据
 * 名录：文化和旅游部（数据截止 2025-03），共 ${rows.length} 家
 * 坐标：WGS84，来自开源数据集 tuansuwu/china-5a-scenic-areas（CC BY-SA 4.0）
 *       上游原始坐标为中文维基 / OpenStreetMap / Wikidata 校正后的结果
 * 紧凑数组：[名称, 省adcode, 城市, 评定年份, lat, lng, 类型]；0 表示坐标未解析
 * 体积约 ${Math.round(rows.length * 0.081)}KB，直接进主包，不需要云端读，断网可用。
 * 由 scripts/data/parse-5a.js → match-5a.js 生成，请勿手改。
 */
module.exports = {
  v: 1,
  total: ${rows.length},
  geo: ${geo},
  list: ${JSON.stringify(compact)}
};
`;
fs.mkdirSync(path.dirname(TARGET), { recursive: true });
fs.writeFileSync(TARGET, out, 'utf8');

console.log('名录:', rows.length, '| 有坐标:', geo, '(' + ((geo / rows.length) * 100).toFixed(1) + '%)');
console.log('  人工', stat.manual, '| 精确', stat.exact, '| 别名', stat.alias, '| 包含', stat.fuzzy);
console.log('文件大小:', (fs.statSync(TARGET).size / 1024).toFixed(1) + ' KB');
if (still.length) {
  console.log('--- 仍缺坐标 (' + still.length + ') ---');
  still.forEach((r) => console.log('  [' + r.prov + ']', r.city, r.name, '—', r.reason));
}
if (rejected.length) {
  console.log('--- 坐标落省界外已作废 (' + rejected.length + ') ---');
  rejected.forEach((r) => console.log('  [' + r.prov + ']', r.city, r.name, '→', r.upstream, r.lat, r.lng, '偏' + (r.dist * 111).toFixed(0) + 'km'));
}
